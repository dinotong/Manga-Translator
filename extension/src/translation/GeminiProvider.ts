import { classifyQuotaError } from '../core/quota';
import { bytesToBase64 } from '../shared/blob-bridge';
import { PipelineError } from '../shared/errors';
import { LANG_NAMES, type SourceLang, type TargetLang } from '../shared/lang';
import { makeLog } from '../shared/log';

const log = makeLog('gemini');

/**
 * Read and translate a whole page in one Gemini call.
 *
 * M0 measured manga-ocr at 5.27 s per bubble in the browser, roughly ten times
 * over budget, because it decodes autoregressively and gains little from the
 * GPU. Gemini is multimodal, so it does the reading and the translating together
 * and removes the local recogniser from the critical path (ADR-001). Detection
 * stays local: PP-OCR gives pixel-accurate boxes in ~120 ms, and an overlay is
 * only as good as its coordinates.
 *
 * This lives in the service worker, not the content script. A content script
 * runs under the *page's* CSP, so a site with a strict connect-src would break
 * translation on that site only — an impossible-to-diagnose bug report.
 */

export interface GeminiConfig {
  apiKey: string;
  model: string;
  from: SourceLang;
  to: TargetLang;
  safetyOff: boolean;
  /** Previous page's bubbles, so dialogue stays coherent across a page turn. */
  context?: readonly { src: string; out: string }[];
}

export interface ReadResult {
  src: string;
  out: string;
}

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          src: { type: 'string' },
          out: { type: 'string' },
        },
        required: ['id', 'src', 'out'],
      },
    },
  },
  required: ['items'],
};

/**
 * All four adjustable categories off.
 *
 * Adult manga is a normal case for this tool, and a translator that silently
 * drops half a page is worse than one that fails loudly. The non-configurable
 * child-safety protections still apply, so a refusal remains possible — the
 * caller must treat it as an expected outcome, not a crash.
 */
const SAFETY_OFF = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_NONE' }));

function buildPrompt(cfg: GeminiConfig): string {
  const src = LANG_NAMES[cfg.from] ?? cfg.from;
  const dst = LANG_NAMES[cfg.to] ?? cfg.to;

  return [
    `You are a professional manga translator working ${src} -> ${dst}.`,
    'Each image is one speech bubble or caption cropped from a single manga page, in reading order.',
    '',
    'For every image, in order, return:',
    '  id  - the 1-based index as a string',
    `  src - the ${src} text exactly as printed, no corrections`,
    `  out - a natural ${dst} translation`,
    '',
    'Rules:',
    `- Translate the way ${dst} manga actually reads, not literally word for word.`,
    '- Never add information that is not in the source. Never invent dialogue.',
    '- No notes, no explanations, no romanization.',
    "- Keep each character's tone and register.",
    '- When unsure, stay close to the literal meaning.',
    `- Render sound effects as ${dst} sound effects.`,
    '- If an image has no readable text, return empty strings for src and out.',
    '- Return exactly one item per image, in the same order.',
    cfg.context?.length
      ? `\nEarlier dialogue for continuity:\n${cfg.context.map((c) => `${c.src} -> ${c.out}`).join('\n')}`
      : '',
  ].join('\n');
}

export class GeminiProvider {
  readonly id = 'gemini';

  constructor(private readonly cfg: GeminiConfig) {
    if (!cfg.apiKey.trim()) {
      throw new PipelineError('NO_API_KEY', 'Gemini API key is empty');
    }
  }

  get model(): string {
    return this.cfg.model;
  }

  /** Recognizer identity for the OCR cache key. Changing model invalidates readings. */
  get recognizerId(): string {
    return `gemini-vision@${this.cfg.model}`;
  }

  /**
   * One request for the whole page.
   *
   * The free tier meters requests per day (1,000), not tokens, so nine bubbles
   * as nine calls would burn nine times the quota. Batching also lets the model
   * see the page at once, which is what keeps pronouns and tone consistent
   * between bubbles.
   */
  async readPage(crops: readonly ArrayBuffer[], signal?: AbortSignal): Promise<ReadResult[]> {
    if (crops.length === 0) return [];

    const parts: unknown[] = [
      { text: buildPrompt(this.cfg) },
      ...crops.map((buf) => ({
        inline_data: { mime_type: 'image/webp', data: bytesToBase64(buf) },
      })),
    ];

    const items = await this.call(parts, signal);
    // Pad rather than throw on a short reply: nine good bubbles beat none.
    return crops.map((_, i) => ({ src: items[i]?.src ?? '', out: items[i]?.out ?? '' }));
  }

  /**
   * Retry a refused page one bubble at a time.
   *
   * A refusal is almost always triggered by one panel, and failing the whole
   * page for it means the user loses eight good translations to protect them
   * from one. Costs N requests instead of 1, which is why it is the fallback and
   * not the default.
   */
  async readPageIndividually(
    crops: readonly ArrayBuffer[],
    signal?: AbortSignal,
  ): Promise<(ReadResult | null)[]> {
    const out: (ReadResult | null)[] = [];
    for (const crop of crops) {
      try {
        const [only] = await this.readPage([crop], signal);
        out.push(only ?? null);
      } catch (err) {
        if (err instanceof PipelineError && err.code === 'PROVIDER_REFUSED') {
          out.push(null);
          continue;
        }
        throw err;
      }
    }
    return out;
  }

  /**
   * Translate strings that were already read.
   *
   * Used when the OCR cache hits but the translation cache does not — a
   * different target language, or a different provider. Re-reading the image
   * would work too and would be strictly more expensive.
   */
  async translateBatch(texts: readonly string[], signal?: AbortSignal): Promise<string[]> {
    const live = texts.map((t, i) => ({ i, t: t.trim() })).filter((x) => x.t.length > 0);
    if (live.length === 0) return texts.map(() => '');

    const payload = JSON.stringify({
      items: live.map((x, n) => ({ id: String(n + 1), src: x.t })),
    });

    const items = await this.call(
      [
        {
          text: [
            buildPrompt(this.cfg),
            '',
            'The text is given below as JSON instead of images. Echo each src back unchanged.',
            payload,
          ].join('\n'),
        },
      ],
      signal,
    );

    const out = texts.map(() => '');
    live.forEach((x, n) => {
      out[x.i] = items[n]?.out ?? '';
    });
    return out;
  }

  private async call(parts: unknown[], signal?: AbortSignal): Promise<ReadResult[]> {
    let res: Response;
    try {
      res = await fetch(`${ENDPOINT}/${encodeURIComponent(this.cfg.model)}:generateContent`, {
        method: 'POST',
        // Trimmed at the point of use: a key pasted from a terminal or a .env
        // file arrives with a newline or quotes attached often enough that the
        // resulting 400 is worth pre-empting.
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.cfg.apiKey.trim() },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          ...(this.cfg.safetyOff ? { safetySettings: SAFETY_OFF } : {}),
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.3,
          },
        }),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw new PipelineError('CANCELLED', 'aborted');
      throw new PipelineError('OFFLINE', `could not reach Gemini: ${String(err)}`);
    }

    if (!res.ok) throw await httpError(res, this.cfg.model);

    const json = (await res.json()) as GeminiResponse;

    const blocked = json.promptFeedback?.blockReason;
    if (blocked) throw new PipelineError('PROVIDER_REFUSED', `blockReason=${blocked}`);

    const candidate = json.candidates?.[0];
    if (candidate?.finishReason === 'SAFETY') {
      throw new PipelineError('PROVIDER_REFUSED', 'finishReason=SAFETY');
    }

    const text = candidate?.content?.parts?.[0]?.text ?? '';
    try {
      return (JSON.parse(text) as { items?: ReadResult[] }).items ?? [];
    } catch {
      log.warn('unparsable response', text.slice(0, 200));
      throw new PipelineError('VALIDATION_FAILED', 'Gemini returned unparsable JSON');
    }
  }
}

/** Map HTTP status onto codes the UI can turn into a next step. */
async function httpError(res: Response, model: string): Promise<PipelineError> {
  const detail = await res.text().catch(() => '');

  if (res.status === 429) {
    // The whole body is classified before it is truncated: the discriminator
    // between "wait 30 seconds" and "this key is finished for the day" lives in
    // `error.details[].violations[].quotaId`, well past the 200th character.
    const quota = classifyQuotaError(detail);
    const err = new PipelineError(
      'QUOTA_EXCEEDED',
      `${quota.scope}${quota.limit ? ` limit=${quota.limit}` : ''}: ${detail.slice(0, 160)}`,
      quota.scope === 'per-minute'
        ? `ยิงเกิน ${quota.limit ?? 15} คำขอ/นาที — รอประมาณ ${Math.ceil((quota.retryAfterMs ?? 30_000) / 1000)} วินาทีแล้วลองใหม่`
        : '',
    );
    err.quota = quota;
    return err;
  }
  if (res.status === 400 && /API_KEY_INVALID|API key not valid/i.test(detail)) {
    return new PipelineError('INVALID_KEY', detail.slice(0, 200));
  }
  if (res.status === 401 || res.status === 403) {
    return new PipelineError('INVALID_KEY', detail.slice(0, 200));
  }
  if (res.status === 404) {
    // The exact failure that made pinning a version a rule: Google retires
    // point releases and the model simply stops existing for new keys.
    return new PipelineError(
      'VALIDATION_FAILED',
      `โมเดล "${model}" ไม่มีอยู่แล้ว — ใช้ชื่อที่ลงท้ายด้วย -latest`,
      `เปิดหน้าตั้งค่าแล้วเปลี่ยนโมเดลเป็น gemini-flash-lite-latest`,
    );
  }
  return new PipelineError('UNKNOWN', `Gemini HTTP ${res.status}: ${detail.slice(0, 200)}`);
}

interface GeminiResponse {
  candidates?: {
    finishReason?: string;
    content?: { parts?: { text?: string }[] };
  }[];
  promptFeedback?: { blockReason?: string };
}
