import type { LangCode, TextBlock } from '../types';
import type { TextRecognizer } from './types';

/**
 * Read and translate speech bubbles in one Gemini call.
 *
 * M0 measured manga-ocr at 5.27 s per bubble in the browser — roughly ten times
 * over budget — because it decodes autoregressively and gains little from the
 * GPU. Gemini is multimodal, so it can do the reading and the translating
 * together, which removes the local recognizer from the critical path entirely.
 *
 * Detection stays local: PP-OCR gives pixel-accurate boxes in ~120 ms, and an
 * overlay is only as good as its coordinates. Asking a language model to
 * estimate bounding boxes would trade the one thing we already do well.
 *
 * Every crop on the page goes in a single request, which matters twice over:
 * the free tier is metered in requests per day (1,000), not tokens, and the
 * model sees the whole page at once so pronouns and tone stay consistent
 * between bubbles.
 */

export interface GeminiOptions {
  apiKey: string;
  sourceLang: LangCode;
  model?: string;
  targetLang?: string;
  /** Previous page's bubbles, to keep dialogue coherent across a page turn. */
  context?: { src: string; out: string }[];
}

type ResolvedOptions = GeminiOptions & { model: string; targetLang: string };

/**
 * `-latest` rather than a pinned version, on purpose.
 *
 * We originally pinned gemini-2.5-flash-lite and it returned 404: "no longer
 * available to new users". Google retires point releases while the alias keeps
 * tracking whatever the current lite model is, so the alias is the safer
 * default for something friends will install and forget about. Anyone who wants
 * reproducible benchmark numbers should pin a version explicitly.
 */
export const GEMINI_DEFAULTS = {
  model: 'gemini-flash-lite-latest',
  targetLang: 'th',
} as const;

/** Free tier: 1,000 requests/day. Batching a page into one call is what makes that plenty. */
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
 * protections still apply, so a refusal is still possible — pipeline code must
 * treat that as an expected outcome, not a crash.
 */
const SAFETY_OFF = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_NONE' }));

const LANG_NAMES: Record<string, string> = {
  ja: 'Japanese',
  en: 'English',
  ko: 'Korean',
  zh: 'Chinese',
  th: 'Thai',
};

function buildPrompt(from: LangCode, to: string, context?: { src: string; out: string }[]): string {
  const src = LANG_NAMES[from] ?? from;
  const dst = LANG_NAMES[to] ?? to;

  return [
    `You are a professional manga translator working ${src} -> ${dst}.`,
    `Each image is one speech bubble or caption cropped from a single manga page, in reading order.`,
    '',
    'For every image, in order, return:',
    `  id  - the 1-based index as a string`,
    `  src - the ${src} text exactly as printed, no corrections`,
    `  out - a natural ${dst} translation`,
    '',
    'Rules:',
    `- Translate the way ${dst} manga actually reads, not literally word for word.`,
    '- Never add information that is not in the source. Never invent dialogue.',
    '- No notes, no explanations, no romanization.',
    '- Keep each character\'s tone and register.',
    '- When unsure, stay close to the literal meaning.',
    `- Render sound effects as ${dst} sound effects.`,
    '- If an image has no readable text, return empty strings for src and out.',
    '- Return exactly one item per image, in the same order.',
    context?.length
      ? `\nEarlier dialogue for continuity:\n${context.map((c) => `${c.src} -> ${c.out}`).join('\n')}`
      : '',
  ].join('\n');
}

export interface GeminiResult {
  src: string;
  out: string;
}

export class GeminiRefusedError extends Error {
  constructor(reason: string) {
    super(`Gemini refused this page (${reason})`);
    this.name = 'GeminiRefusedError';
  }
}

export class GeminiQuotaError extends Error {
  constructor() {
    super('Gemini quota exceeded (free tier: 15/min, 1000/day)');
    this.name = 'GeminiQuotaError';
  }
}

export class GeminiVisionReader implements TextRecognizer {
  readonly id = 'gemini-vision';
  readonly license = 'API';
  readonly langs: readonly LangCode[] = ['ja', 'en', 'ko', 'zh'];

  private readonly opts: ResolvedOptions;

  constructor(options: GeminiOptions) {
    this.opts = { ...GEMINI_DEFAULTS, ...options };
  }

  get version(): string {
    return this.opts.model;
  }

  async init(): Promise<void> {
    if (!this.opts.apiKey.trim()) throw new Error('Gemini API key is empty');
  }

  /** Single-crop path, so this satisfies TextRecognizer. Prefer readPage. */
  async recognize(crop: ImageBitmap, _block: TextBlock): Promise<string> {
    const [only] = await this.readPage([crop]);
    return only?.src ?? '';
  }

  /**
   * One request for the whole page: read every crop and translate it.
   * Returns one entry per input crop, padded if the model returns fewer.
   */
  async readPage(crops: readonly ImageBitmap[], signal?: AbortSignal): Promise<GeminiResult[]> {
    if (crops.length === 0) return [];

    const images = await Promise.all(crops.map(toInlineData));
    const items = await this.call(
      [
        { text: buildPrompt(this.opts.sourceLang, this.opts.targetLang, this.opts.context) },
        ...images,
      ],
      signal,
    );

    // Pad rather than throw on a short reply: nine good bubbles beat none.
    return crops.map((_, i) => ({
      src: items[i]?.src ?? '',
      out: items[i]?.out ?? '',
    }));
  }

  /**
   * Text mode: translate already-extracted strings, no images attached.
   *
   * Same request count as vision mode — the free tier meters requests per day,
   * not tokens, so batching a page into one call is what actually protects the
   * quota. What this saves is tokens (~250 per crop), which only starts to
   * matter on a paid tier. The catch is that something else has to do the OCR
   * first, and locally that is currently the slow path.
   */
  async translateBatch(texts: readonly string[], signal?: AbortSignal): Promise<GeminiResult[]> {
    const live = texts.map((t, i) => ({ i, t: t.trim() })).filter((x) => x.t.length > 0);
    if (live.length === 0) return texts.map(() => ({ src: '', out: '' }));

    const payload = JSON.stringify({
      items: live.map((x, n) => ({ id: String(n + 1), src: x.t })),
    });

    const results = await this.call([
      {
        text: [
          buildPrompt(this.opts.sourceLang, this.opts.targetLang, this.opts.context),
          '',
          'The text is given below as JSON instead of images. Echo each src back unchanged.',
          payload,
        ].join('\n'),
      },
    ], signal);

    const out = texts.map(() => ({ src: '', out: '' }));
    live.forEach((x, n) => {
      out[x.i] = { src: x.t, out: results[n]?.out ?? '' };
    });
    return out;
  }

  dispose(): void {}

  /** Shared request path for both modes. */
  private async call(
    parts: unknown[],
    signal?: AbortSignal,
  ): Promise<GeminiResult[]> {
    const res = await fetch(
      `${ENDPOINT}/${encodeURIComponent(this.opts.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.opts.apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          safetySettings: SAFETY_OFF,
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.3,
          },
        }),
        ...(signal ? { signal } : {}),
      },
    );

    if (res.status === 429) throw new GeminiQuotaError();
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Gemini HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }

    const json = (await res.json()) as GeminiResponse;

    const blocked = json.promptFeedback?.blockReason;
    if (blocked) throw new GeminiRefusedError(blocked);

    const candidate = json.candidates?.[0];
    if (candidate?.finishReason === 'SAFETY') throw new GeminiRefusedError('SAFETY');

    try {
      const text = candidate?.content?.parts?.[0]?.text ?? '';
      return (JSON.parse(text) as { items?: GeminiResult[] }).items ?? [];
    } catch {
      throw new Error('Gemini returned unparsable JSON');
    }
  }
}

interface GeminiResponse {
  candidates?: {
    finishReason?: string;
    content?: { parts?: { text?: string }[] };
  }[];
  promptFeedback?: { blockReason?: string };
}

/** ImageBitmap -> the inline_data part the REST API expects. */
async function toInlineData(bitmap: ImageBitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  ctx.drawImage(bitmap, 0, 0);

  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  const buffer = await blob.arrayBuffer();

  // Chunked so a large crop does not blow the argument limit of String.fromCharCode.
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return { inline_data: { mime_type: blob.type, data: btoa(binary) } };
}
