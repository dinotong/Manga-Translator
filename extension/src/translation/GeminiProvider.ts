import {
  cropId,
  GROUP_INSTRUCTIONS,
  pageHeader,
  type ReadGroup,
  type ReadItem,
  routeGroups,
  routeItems,
  type Routed,
  type RoutedGroup,
} from '../core/batch';
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
  /**
   * Ask the model which crops are fragments of one continuous text.
   *
   * What comes back is a proposal, not an instruction — core/merge-proposals.ts
   * vetoes it on geometry — and the prompt still demands one item per crop, so
   * turning this off gives back the exact answer the page would have had before
   * groups existed. That is what makes it a safe switch to hand the reader.
   */
  grouping: boolean;
  /** Previous page's bubbles, so dialogue stays coherent across a page turn. */
  context?: readonly { src: string; out: string }[];
}

export interface ReadResult {
  src: string;
  out: string;
}

/** A batched reply: answers routed to their crops, plus any merges proposed. */
export interface PagesRead extends Routed {
  /** Per page, in the order the pages were sent. Empty when grouping is off. */
  groups: RoutedGroup[][];
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
    // Deliberately absent from `required`: a page with nothing to group has to
    // be able to say so by omitting the field, and a schema that demands it
    // invites the model to produce one to fill the slot.
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          src: { type: 'string' },
          out: { type: 'string' },
        },
        required: ['ids', 'src', 'out'],
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

function buildPrompt(cfg: GeminiConfig, pages = 1, grouping = cfg.grouping): string {
  const src = LANG_NAMES[cfg.from] ?? cfg.from;
  const dst = LANG_NAMES[cfg.to] ?? cfg.to;

  // Two grammatical slots, and 'auto' does not fit both. LANG_NAMES.auto is a
  // noun phrase — "the language printed in the image" — which reads correctly
  // after "working", and as "the the language printed in the image text" in the
  // field description below. Naming a concrete language there would be worse
  // than clumsy: on 'auto' we do not know it, and asserting one invites the
  // model to correct what it sees into what it was told to expect.
  const srcField = cfg.from === 'auto' ? 'source' : src;

  return [
    `You are a professional manga translator working ${src} -> ${dst}.`,
    pages > 1
      ? // Saying "a single manga page" here would be a lie once several pages
        // ride in one request, and a believable one: the model would happily
        // carry a speaker or an honorific from the last bubble of page 2 into
        // the first bubble of page 3, and the result reads perfectly while being
        // about the wrong characters. The PAGE markers below are the boundary.
        `This request contains ${pages} separate manga pages. Each image is one speech bubble or caption. A "--- PAGE" line precedes each page's images; the pages are unrelated to one another and must be translated independently.`
      : 'Each image is one speech bubble or caption cropped from a single manga page, in reading order.',
    '',
    'For every image, return:',
    pages > 1
      ? '  id  - exactly the id given for that image on its PAGE line, e.g. "p2b3"'
      : `  id  - the id given for that image, e.g. "${cropId(0, 0)}"`,
    `  src - the ${srcField} text exactly as printed, no corrections`,
    `  out - a natural ${dst} translation`,
    '',
    ...(grouping ? [...GROUP_INSTRUCTIONS, ''] : []),
    'Rules:',
    `- Translate the way ${dst} manga actually reads, not literally word for word.`,
    '- Never add information that is not in the source. Never invent dialogue.',
    '- No notes, no explanations, no romanization.',
    "- Keep each character's tone and register.",
    '- When unsure, stay close to the literal meaning.',
    `- Render sound effects as ${dst} sound effects.`,
    '- If an image has no readable text, return empty strings for src and out.',
    '- Return exactly one item per image, and always echo its id back verbatim.',
    pages > 1
      ? '- Never let dialogue, names or pronouns from one PAGE influence another.'
      : '',
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
   * One request for several whole pages.
   *
   * Two levels of batching, for two different reasons. Bubbles are batched
   * within a page because the free tier meters requests, not tokens, and because
   * the model seeing the page at once is what keeps pronouns and tone consistent
   * between bubbles. Pages are batched with each other purely for throughput:
   * measured, a single-page request costs 1.3-41 s almost independently of its
   * size, so the second and third page ride along nearly free. See core/batch.ts
   * for the caps and for why the reply is routed by id rather than by order.
   */
  async readPages(
    pages: readonly (readonly ArrayBuffer[])[],
    signal?: AbortSignal,
  ): Promise<PagesRead> {
    const cropsPerPage = pages.map((p) => p.length);
    if (cropsPerPage.every((n) => n === 0)) {
      return { perPage: cropsPerPage.map(() => []), missed: [], groups: cropsPerPage.map(() => []) };
    }

    const parts: unknown[] = [{ text: buildPrompt(this.cfg, pages.length) }];
    pages.forEach((crops, page) => {
      if (crops.length === 0) return;
      if (pages.length > 1) parts.push({ text: pageHeader(page, crops.length, pages.length) });
      crops.forEach((buf, block) => {
        // The id travels as a text part immediately before its image. Putting it
        // in the prompt as a list instead would make the model count, and a
        // model that miscounts produces ids that look valid and point at the
        // wrong bubble.
        parts.push({ text: `id: ${cropId(page, block)}` });
        parts.push({ inline_data: { mime_type: 'image/webp', data: bytesToBase64(buf) } });
      });
    });

    const reply = await this.call(parts, signal);
    return {
      ...routeItems(cropsPerPage, reply.items),
      groups: this.cfg.grouping
        ? routeGroups(cropsPerPage, reply.groups)
        : cropsPerPage.map(() => []),
    };
  }

  /**
   * One page, as the rest of the code has always asked for it.
   *
   * Kept as its own entry point because the per-block refusal retry below needs
   * to send exactly one crop and get exactly one answer, and because a lone page
   * is still the common case for anything the reader is looking at right now.
   */
  async readPage(crops: readonly ArrayBuffer[], signal?: AbortSignal): Promise<ReadResult[]> {
    if (crops.length === 0) return [];
    const { perPage } = await this.readPages([crops], signal);
    // Pad rather than throw on a short reply: nine good bubbles beat none.
    return crops.map((_, i) => perPage[0]?.[i] ?? { src: '', out: '' });
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

    const { items } = await this.call(
      [
        {
          text: [
            // Grouping off on this path whatever the setting says: it is handed
            // strings that were already read and has no images to regroup.
            buildPrompt(this.cfg, 1, false),
            '',
            'The text is given below as JSON instead of images. Echo each src back unchanged.',
            payload,
          ].join('\n'),
        },
      ],
      signal,
    );

    // Positional, and safely so: this path sends one flat list of strings and
    // gets one flat list back, with no page boundary anywhere to cross.
    const out = texts.map(() => '');
    live.forEach((x, n) => {
      const got = items[n]?.out;
      out[x.i] = typeof got === 'string' ? got : '';
    });
    return out;
  }

  private async call(
    parts: unknown[],
    signal?: AbortSignal,
  ): Promise<{ items: ReadItem[]; groups: ReadGroup[] }> {
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
      const json = JSON.parse(text) as { items?: ReadItem[]; groups?: ReadGroup[] };
      return { items: json.items ?? [], groups: json.groups ?? [] };
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
