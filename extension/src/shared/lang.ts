import type { LangCode } from '../types';

/**
 * Language is a parameter everywhere, never a literal.
 *
 * The project ships ja->th first and en->th later, and the only thing that makes
 * that a one-line change instead of a rewrite is refusing to bake 'ja'/'th' into
 * cache keys, prompts and reading order. `from` and `to` travel together through
 * every layer for exactly that reason.
 */

/** What the user (or a site profile) may ask for as the source. */
export type SourceLang = LangCode | 'auto';

/** Target languages we can lay out. Thai first; the list is what the UI offers. */
export type TargetLang = 'th' | 'en';

export const SOURCE_LANGS: readonly SourceLang[] = ['auto', 'ja', 'en', 'ko', 'zh'];
export const TARGET_LANGS: readonly TargetLang[] = ['th', 'en'];

/** English names, because that is what the model prompt speaks. */
export const LANG_NAMES: Record<string, string> = {
  ja: 'Japanese',
  en: 'English',
  ko: 'Korean',
  zh: 'Chinese',
  th: 'Thai',
  auto: 'the language printed in the image',
};

/** Thai labels for the popup/options UI. */
export const LANG_LABELS_TH: Record<string, string> = {
  auto: 'ตรวจอัตโนมัติ',
  ja: 'ญี่ปุ่น',
  en: 'อังกฤษ',
  ko: 'เกาหลี',
  zh: 'จีน',
  th: 'ไทย',
};

/**
 * The concrete language to hand the detector's direction heuristics.
 *
 * Detection itself is language-agnostic, but the vertical/horizontal thresholds
 * differ between CJK and Latin. 'auto' has to resolve to something before that
 * point; ja is the right guess for a manga reader and costs nothing if wrong,
 * since the recognizer sees the actual glyphs anyway.
 */
export function resolveDetectionLang(source: SourceLang): LangCode {
  return source === 'auto' ? 'ja' : source;
}

/** Cache-key fragment. Kept as its own function so key format changes stay in one place. */
export function langPair(from: SourceLang, to: TargetLang): string {
  return `${from}-${to}`;
}
