import {
  cropId,
  GROUP_INSTRUCTIONS,
  type ReadGroup,
  type ReadItem,
  routeGroups,
  routeItems,
  type RoutedGroup,
} from '../core/batch';
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
  /**
   * Ask the model which crops are one continuous text. On by default, and off is
   * a first-class answer: what comes back is a *proposal*, vetoed on geometry in
   * core/merge-proposals.ts, and the owner must be able to switch the whole idea
   * off in one click if ordinary pages read worse.
   */
  grouping?: boolean;
  /** Previous page's bubbles, to keep dialogue coherent across a page turn. */
  context?: { src: string; out: string }[];
}

type ResolvedOptions = GeminiOptions & { model: string; targetLang: string; grouping: boolean };

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
  grouping: true,
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
    // Deliberately not in `required`: a page with nothing to group must be able
    // to say so by omission, and a schema that demands the field invites the
    // model to invent one.
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

function buildPrompt(
  from: LangCode,
  to: string,
  grouping: boolean,
  context?: { src: string; out: string }[],
): string {
  const src = LANG_NAMES[from] ?? from;
  const dst = LANG_NAMES[to] ?? to;

  return [
    `You are a professional manga translator working ${src} -> ${dst}.`,
    `Each image is one speech bubble or caption cropped from a single manga page, in reading order.`,
    '',
    'For every image, return:',
    `  id  - the id given for that image, e.g. "${cropId(0, 0)}"`,
    `  src - the ${src} text exactly as printed, no corrections`,
    `  out - a natural ${dst} translation`,
    '',
    ...(grouping ? [...GROUP_INSTRUCTIONS, ''] : []),
    'Rules:',
    `- Translate the way ${dst} manga actually reads, not literally word for word.`,
    '- Never add information that is not in the source. Never invent dialogue.',
    '- No notes, no explanations, no romanization.',
    '- Keep each character\'s tone and register.',
    '- When unsure, stay close to the literal meaning.',
    `- Render sound effects as ${dst} sound effects.`,
    '- If an image has no readable text, return empty strings for src and out.',
    '- Return exactly one item per image, and always echo its id back verbatim.',
    context?.length
      ? `\nEarlier dialogue for continuity:\n${context.map((c) => `${c.src} -> ${c.out}`).join('\n')}`
      : '',
  ].join('\n');
}

export interface GeminiResult {
  src: string;
  out: string;
}

/** One page's reading: an answer per crop, plus whatever the model wants merged. */
export interface PageReading {
  items: (GeminiResult | null)[];
  groups: RoutedGroup[];
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
    const { items } = await this.readPage([crop]);
    return items[0]?.src ?? '';
  }

  /**
   * One request for the whole page: read every crop and translate it.
   *
   * The reply is routed back by the id travelling with each image, never by
   * position — same rule and same code as the extension (core/batch.ts), because
   * putting one bubble's words in another bubble's box is the failure the reader
   * cannot see.
   */
  async readPage(crops: readonly ImageBitmap[], signal?: AbortSignal): Promise<PageReading> {
    if (crops.length === 0) return { items: [], groups: [] };

    const parts: unknown[] = [
      {
        text: buildPrompt(
          this.opts.sourceLang,
          this.opts.targetLang,
          this.opts.grouping,
          this.opts.context,
        ),
      },
    ];
    for (const [i, crop] of crops.entries()) {
      parts.push({ text: `id: ${cropId(0, i)}` });
      parts.push(await toInlineData(crop));
    }

    const reply = await this.call(parts, signal);
    const { perPage, unidentified, positional } = routeItems([crops.length], reply.items);
    // The harness exists to answer questions like "does the model actually echo
    // our ids?" with an observation instead of an argument. Both of these should
    // be silent on every reply: `id` is required by the response schema and each
    // id is pinned to its image in the request.
    if (unidentified > 0) {
      console.warn(
        `[gemini] ${unidentified}/${reply.items.length} items came back with an unreadable id`,
        reply.items.map((i) => i.id),
      );
    }
    if (positional) {
      console.warn('[gemini] reply carried no ids at all — placed by position');
    }
    return {
      items: perPage[0] ?? crops.map(() => null),
      groups: this.opts.grouping ? (routeGroups([crops.length], reply.groups)[0] ?? []) : [],
    };
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

    const reply = await this.call([
      {
        text: [
          // No grouping here: this path is handed strings that were already
          // read, so there is nothing left to regroup.
          buildPrompt(this.opts.sourceLang, this.opts.targetLang, false, this.opts.context),
          '',
          'The text is given below as JSON instead of images. Echo each src back unchanged.',
          payload,
        ].join('\n'),
      },
    ], signal);

    const out = texts.map(() => ({ src: '', out: '' }));
    live.forEach((x, n) => {
      const got = reply.items[n]?.out;
      out[x.i] = { src: x.t, out: typeof got === 'string' ? got : '' };
    });
    return out;
  }

  dispose(): void {}

  /** Shared request path for both modes. */
  private async call(
    parts: unknown[],
    signal?: AbortSignal,
  ): Promise<{ items: ReadItem[]; groups: ReadGroup[] }> {
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
      const json = JSON.parse(text) as { items?: ReadItem[]; groups?: ReadGroup[] };
      return { items: json.items ?? [], groups: json.groups ?? [] };
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
