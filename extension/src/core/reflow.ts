/**
 * Joining the line breaks a model copies from the source layout.
 *
 * Asked to translate a vertical Japanese bubble, Gemini sometimes mirrors the
 * columns: one line per column, so 「おはよう！」 printed one kana per column
 * comes back as one Thai syllable per line. The overlay cannot keep those
 * breaks — it reflows text to the panel — and HTML collapses each `\n` to a
 * space. In a script that writes words without spaces between them, a space
 * inside a word is a visible error: measured on the store sample page, a
 * single Thai greeting rendered as seven fragments.
 *
 * Every line break inside a translation is therefore treated as a layout
 * artefact. Between two characters of a script that does not separate words
 * with spaces, it is dropped; anywhere else it becomes one space, which is what
 * the line break was standing in for. No language code is consulted: the
 * characters on either side decide, so this holds for any target language.
 */

/**
 * Scripts written without spaces between words. A break between two of these
 * characters joins them directly. Thai, Lao, Khmer, Myanmar, and the CJK
 * scripts including kana.
 */
const NO_SPACE =
  /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** Characters that attach to the one before them and say nothing about spacing on their own. */
const MARK = /\p{M}/u;

/** One whitespace code unit, exactly as the regex class `\s` defines it. */
const SPACE = /\s/;

/** Punctuation hangs on the word before it in every script here. */
const HANGING = /[\p{Pe}\p{Pf}\p{Po}]/u;

export function joinLayoutBreaks(text: string): string {
  // Every maximal run of whitespace that contains at least one line break is
  // replaced as a whole, judged by what is on either side of it. Plain spaces
  // the model chose to write are left alone.
  //
  // A single forward scan, not `/[^\S\n]*\n\s*/g`: that pattern retries from
  // every position inside a long run of spaces with no line break in it, which
  // is quadratic — measured at 4.6 s for 64,000 spaces. Every character \s
  // matches is a single UTF-16 unit, so scanning by unit is exact.
  let out = '';
  let copied = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (!SPACE.test(text[i]!)) {
      i++;
      continue;
    }
    let j = i;
    let breaks = false;
    while (j < n && SPACE.test(text[j]!)) {
      if (text[j] === '\n') breaks = true;
      j++;
    }
    if (breaks) {
      out += text.slice(copied, i) + joiner(lastBase(text, i), text.charAt(j));
      copied = j;
    }
    i = j;
  }
  return (out + text.slice(copied)).trim();
}

/** What a line-break run between `before` and `after` becomes. */
function joiner(before: string, after: string): string {
  if (!before || !after) return '';
  if (HANGING.test(after)) return '';
  return NO_SPACE.test(before) && NO_SPACE.test(after) ? '' : ' ';
}

/**
 * The nearest character before `end` that is not a combining mark.
 *
 * Walks backward one code point at a time and stops at the first base
 * character, so the cost is the length of the mark run, not of the prefix.
 */
function lastBase(s: string, end: number): string {
  let k = end;
  while (k > 0) {
    let from = k - 1;
    const unit = s.charCodeAt(from);
    if (unit >= 0xdc00 && unit <= 0xdfff && from > 0) {
      const lead = s.charCodeAt(from - 1);
      if (lead >= 0xd800 && lead <= 0xdbff) from--;
    }
    const ch = s.slice(from, k);
    if (!MARK.test(ch)) return ch;
    k = from;
  }
  return '';
}
