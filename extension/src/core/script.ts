import type { LangCode } from '../types';

/**
 * Which script a page turned out to be written in, from the text the model
 * already sent back.
 *
 * ## Why this exists (D-038)
 *
 * The source language defaults to `auto`, and `auto` did no detection at all —
 * `resolveDetectionLang` mapped it to `'ja'`. That is not a harmless default,
 * because language is not only a label on the prompt. It picks the aspect-ratio
 * threshold and the fallback that `detectDirection` uses, and direction then
 * decides whether `panelRect` widens a box to 14% of the page and which
 * thresholds `grouping.ts` applies. Measured on the owner's page, an English
 * chapter read as `ja` produced 9 blocks of which 8 were called vertical; the
 * same page read as `en` produced 12 blocks, none vertical. The owner confirmed
 * the second is dramatically better.
 *
 * ## Why the reply and not the pixels
 *
 * The obvious alternative is to ask the page's own geometry: classify the lines
 * that are decisive and let them settle the ambiguous ones. That was built and
 * measured on the failing page, and it does not work. The detector dilates the
 * probability map to join glyphs into lines, and at the shipped radius that also
 * joins the *lines of a balloon* into one blob — so a detected box is the shape
 * of the balloon, not of the writing. On the owner's English page the twelve
 * boxes measured (w/h) 0.56, 0.58, 0.62, 0.74, 0.74, 0.74, 0.85, 1.01, 1.06,
 * 1.12, 1.28, 3.22: three of them are decisively taller than wide at Japanese's
 * 1.4 threshold and only one is decisively wider. A page vote therefore returns
 * `vertical` for a page with no Japanese on it at all. The signal is not weak,
 * it is wrong, so it is not shipped.
 *
 * The reply has no such problem. The model returns `src` — the text as printed —
 * for every crop, so after the first page of a gallery the script is simply in
 * hand, at no extra request and with no guessing from shapes.
 */

/**
 * How much text is enough to answer.
 *
 * Two considerations pull the same way. A single bubble reading "!?" or a name
 * in Latin letters inside a Japanese page says nothing, and a wrong answer here
 * is remembered for a whole gallery. Sixteen scripted characters is roughly one
 * short line of dialogue — small enough that the first page of any real chapter
 * clears it, large enough that punctuation and a sound effect do not.
 */
export const MIN_SCRIPT_CHARS = 16;

/**
 * How dominant the winner must be.
 *
 * A Japanese page routinely carries Latin — signage, a name, an English
 * exclamation — and an English page carries almost no kana. So this is not a
 * simple majority: the winner must hold three quarters of the scripted
 * characters, and anything less is reported as unknown rather than guessed.
 */
export const SCRIPT_MAJORITY = 0.75;

interface Counts {
  ja: number;
  ko: number;
  zh: number;
  en: number;
}

/**
 * Count characters by script.
 *
 * Han is counted separately from kana because it belongs to both Japanese and
 * Chinese, and it is the *kana* that tell them apart: Japanese prose cannot go
 * long without them, and Chinese has none at all.
 */
function count(text: string): Counts & { han: number } {
  const c = { ja: 0, ko: 0, zh: 0, en: 0, han: 0 };
  for (const ch of text) {
    const p = ch.codePointAt(0)!;
    // Hiragana, katakana, katakana phonetic extensions, halfwidth katakana.
    if ((p >= 0x3040 && p <= 0x30ff) || (p >= 0x31f0 && p <= 0x31ff) || (p >= 0xff66 && p <= 0xff9d)) {
      c.ja++;
    } else if ((p >= 0xac00 && p <= 0xd7af) || (p >= 0x1100 && p <= 0x11ff) || (p >= 0x3130 && p <= 0x318f)) {
      c.ko++;
    } else if ((p >= 0x4e00 && p <= 0x9fff) || (p >= 0x3400 && p <= 0x4dbf)) {
      c.han++;
    } else if ((p >= 0x41 && p <= 0x5a) || (p >= 0x61 && p <= 0x7a) || (p >= 0xc0 && p <= 0x24f)) {
      c.en++;
    }
    // Everything else — digits, punctuation, spaces, emoji — is deliberately
    // uncounted. Punctuation is shared by every script here and would only
    // dilute the majority test.
  }
  return c;
}

/**
 * The script of a page's text, or `null` when the sample cannot say.
 *
 * `null` is a real answer and the caller must keep its previous guess rather
 * than treating it as a language. A page of pure sound effects, a title page, a
 * crop that came back empty — all of them legitimately say nothing.
 */
export function detectScript(text: string): LangCode | null {
  const c = count(text);
  // Han with kana beside it is Japanese; Han alone is Chinese. Assigning it
  // before the majority test rather than counting it as its own candidate is
  // what stops a kanji-heavy Japanese line from being read as Chinese.
  const ja = c.ja > 0 ? c.ja + c.han : c.ja;
  const zh = c.ja > 0 ? 0 : c.han;

  const scores: [LangCode, number][] = [
    ['ja', ja],
    ['ko', c.ko],
    ['zh', zh],
    ['en', c.en],
  ];
  const total = scores.reduce((n, [, v]) => n + v, 0);
  if (total < MIN_SCRIPT_CHARS) return null;

  const [lang, best] = scores.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best / total >= SCRIPT_MAJORITY ? lang : null;
}
