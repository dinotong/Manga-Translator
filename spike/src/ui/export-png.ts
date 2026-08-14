/**
 * Burn the overlay into the page and save it as PNG.
 *
 * Everything needed is already in the DOM — the image plus the boxes and their
 * percentage geometry — so this reads the rendered cards rather than threading
 * a second copy of the results through. That also guarantees what gets saved is
 * exactly what was on screen.
 *
 * Drawn manually with fillText instead of rasterising HTML: we already know
 * every box's position, and a DOM-to-canvas library would add a dependency to
 * reproduce information we have.
 */

export interface ExportOptions {
  /** Pause between downloads so the browser does not block the burst. */
  gapMs: number;
  /** Panel colour drawn over the original text. */
  panel: string;
  ink: string;
  fontStack: string;
}

export const EXPORT_DEFAULTS: ExportOptions = {
  gapMs: 300,
  panel: 'rgba(255,255,255,0.96)',
  ink: '#10131a',
  fontStack: '"Noto Sans Thai", "Leelawadee UI", Tahoma, sans-serif',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

/** Recover box geometry from the inline percentage styles the renderer wrote. */
function readBoxes(card: Element): Box[] {
  return [...card.querySelectorAll<HTMLElement>('.box')].flatMap((el) => {
    const text = el.querySelector('.tx')?.textContent?.trim() ?? '';
    if (!text) return [];
    const num = (v: string) => Number.parseFloat(v) / 100;
    return [
      {
        x: num(el.style.left),
        y: num(el.style.top),
        w: num(el.style.width),
        h: num(el.style.height),
        text,
      },
    ];
  });
}

/**
 * Wrap text to a pixel width.
 *
 * Thai writes without spaces between words, so a space-based wrapper would
 * produce one enormous unbreakable line. Breaking per character is not
 * linguistically correct — proper segmentation needs ICU — but it keeps the
 * text inside the bubble, which is what matters here.
 */
function wrap(ctx: OffscreenCanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';

  for (const ch of text) {
    const next = line + ch;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = ch;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Largest font size at which the text still fits the box.
 *
 * Binary search rather than a formula: the formula in render.ts only has to be
 * close enough for CSS to finish the job, but here nothing clips overflow for
 * us, so an overlong line would simply be painted outside its bubble.
 */
function fitFont(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  box: { w: number; h: number },
  opts: ExportOptions,
): { size: number; lines: string[] } {
  let lo = 6;
  let hi = Math.max(8, Math.floor(box.h * 0.9));
  let best = { size: lo, lines: [text] };

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    ctx.font = `600 ${mid}px ${opts.fontStack}`;
    const lines = wrap(ctx, text, box.w);

    if (lines.length * mid * 1.2 <= box.h) {
      best = { size: mid, lines };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function roundRect(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fill();
}

/** Compose one card into a PNG blob at the image's natural resolution. */
export async function renderCardToPng(
  card: Element,
  options: Partial<ExportOptions> = {},
): Promise<Blob | null> {
  const opts = { ...EXPORT_DEFAULTS, ...options };
  const img = card.querySelector<HTMLImageElement>('.stage img');
  if (!img || !img.complete || img.naturalWidth === 0) return null;

  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const bitmap = await createImageBitmap(img);
  ctx.drawImage(bitmap, 0, 0, W, H);
  bitmap.close();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const box of readBoxes(card)) {
    // Match the CSS overlay's -3% inset so the panel covers strokes sitting
    // just outside the detected bounds.
    const pad = 0.03;
    const x = (box.x - box.w * pad) * W;
    const y = (box.y - box.h * pad) * H;
    const w = box.w * (1 + pad * 2) * W;
    const h = box.h * (1 + pad * 2) * H;

    ctx.fillStyle = opts.panel;
    roundRect(ctx, x, y, w, h, Math.min(w, h) * 0.12);

    const inner = { w: w * 0.9, h: h * 0.9 };
    const { size, lines } = fitFont(ctx, box.text, inner, opts);

    ctx.fillStyle = opts.ink;
    ctx.font = `600 ${size}px ${opts.fontStack}`;

    const lineHeight = size * 1.2;
    const startY = y + h / 2 - ((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, i) => {
      ctx.fillText(line, x + w / 2, startY + i * lineHeight);
    });
  }

  return canvas.convertToBlob({ type: 'image/png' });
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Save every rendered page, oldest first so the files come out in reading order.
 * Reports progress because a chapter of 40 pages takes a noticeable while.
 */
export async function exportAllCards(
  root: HTMLElement,
  onProgress?: (done: number, total: number) => void,
  options: Partial<ExportOptions> = {},
): Promise<number> {
  const opts = { ...EXPORT_DEFAULTS, ...options };

  // Cards are prepended as they finish, so reverse puts them back in page order.
  const cards = [...root.querySelectorAll('.card:not(.summary):not(.restored)')].reverse();
  if (cards.length === 0) return 0;

  // Without this the first page can be drawn with a fallback face, and Thai
  // metrics differ enough that the fitted size would be wrong.
  await document.fonts.ready;

  let saved = 0;
  for (const [i, card] of cards.entries()) {
    const name = card.querySelector('h2 span')?.textContent?.trim() ?? `page-${i + 1}`;
    const blob = await renderCardToPng(card, opts);
    if (blob) {
      download(blob, `${name.replace(/\.\w+$/, '')}-th.png`);
      saved++;
    }
    onProgress?.(i + 1, cards.length);
    if (i < cards.length - 1) await sleep(opts.gapMs);
  }
  return saved;
}
