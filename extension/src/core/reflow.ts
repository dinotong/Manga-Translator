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

export function joinLayoutBreaks(text: string): string {
  // A run of whitespace that contains at least one line break, with what is on
  // either side of it. Plain spaces the model chose to write are left alone.
  return text
    .replace(/[^\S\n]*\n\s*/g, (run, offset: number, whole: string) => {
      const before = lastBase(whole, offset);
      const after = whole.slice(offset + run.length).charAt(0);
      if (!before || !after) return '';
      // Punctuation hangs on the word before it in every script here.
      if (/[\p{Pe}\p{Pf}\p{Po}]/u.test(after)) return '';
      return NO_SPACE.test(before) && NO_SPACE.test(after) ? '' : ' ';
    })
    .trim();
}

/** The nearest character before `end` that is not a combining mark. */
function lastBase(s: string, end: number): string {
  const chars = Array.from(s.slice(0, end));
  for (let i = chars.length - 1; i >= 0; i--) {
    if (!MARK.test(chars[i]!)) return chars[i]!;
  }
  return '';
}
