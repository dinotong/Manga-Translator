import { describe, expect, it } from 'vitest';
import { joinLayoutBreaks } from './reflow';

describe('joinLayoutBreaks', () => {
  it('rejoins a Thai word the model split one syllable per line', () => {
    // As returned on the store sample page for a vertical greeting.
    expect(joinLayoutBreaks('อา\nรุ\nณ\nส\nวั\nส\nดิ์!')).toBe('อารุณสวัสดิ์!');
  });

  it('looks past a trailing tone mark or vowel to the consonant it sits on', () => {
    expect(joinLayoutBreaks('ที่\nนี่')).toBe('ที่นี่');
  });

  it('hangs punctuation on the word before it', () => {
    expect(joinLayoutBreaks('เอ๊ะ\nไดโนเสาร์\n!?')).toBe('เอ๊ะไดโนเสาร์!?');
    expect(joinLayoutBreaks('Wait\n...')).toBe('Wait...');
  });

  it('turns a break between Latin words into a space', () => {
    expect(joinLayoutBreaks('Good\nmorning!')).toBe('Good morning!');
  });

  it('joins Japanese and Chinese the same way as Thai', () => {
    expect(joinLayoutBreaks('おは\nよう')).toBe('おはよう');
    expect(joinLayoutBreaks('你\n好')).toBe('你好');
  });

  it('uses a space where scripts meet', () => {
    expect(joinLayoutBreaks('OK\nไปกัน')).toBe('OK ไปกัน');
  });

  it('collapses blank lines and the spaces around a break into one decision', () => {
    expect(joinLayoutBreaks('ไป \n\n ผจญภัย')).toBe('ไปผจญภัย');
    expect(joinLayoutBreaks('let us \n\n go')).toBe('let us go');
  });

  it('leaves spaces the model wrote on purpose', () => {
    expect(joinLayoutBreaks('อากาศ ดีจังเลย')).toBe('อากาศ ดีจังเลย');
  });

  it('drops breaks at the very start and end', () => {
    expect(joinLayoutBreaks('\nโฮก!\n')).toBe('โฮก!');
  });

  it('handles empty text', () => {
    expect(joinLayoutBreaks('')).toBe('');
  });
});

/**
 * The regex implementation this replaced, kept verbatim as the reference. The
 * rewrite exists only to make it linear; any difference in output is a bug.
 */
function referenceJoin(text: string): string {
  const NO_SPACE =
    /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const MARK = /\p{M}/u;
  const lastBase = (s: string, end: number): string => {
    const chars = Array.from(s.slice(0, end));
    for (let i = chars.length - 1; i >= 0; i--) {
      if (!MARK.test(chars[i]!)) return chars[i]!;
    }
    return '';
  };
  return text
    .replace(/[^\S\n]*\n\s*/g, (run, offset: number, whole: string) => {
      const before = lastBase(whole, offset);
      const after = whole.slice(offset + run.length).charAt(0);
      if (!before || !after) return '';
      if (/[\p{Pe}\p{Pf}\p{Po}]/u.test(after)) return '';
      return NO_SPACE.test(before) && NO_SPACE.test(after) ? '' : ' ';
    })
    .trim();
}

describe('joinLayoutBreaks matches the regex it replaced', () => {
  // Every class of character the decision depends on, plus the awkward ones:
  // combining marks, surrogate pairs, lone surrogates, and every kind of space.
  const alphabet = [
    'a', 'Z', '1', 'ก', 'ที่', 'ดิ์', '่', '́', 'あ', 'カ', '漢', 'ລ', 'ក', 'မ',
    '!', '?', '.', '」', '）', '"', '-', '😀', '\uD83D', '\uDE00',
    ' ', '\t', '\n', '\r', '　', ' ', ' ', '\v', '\f',
  ];
  // Small deterministic PRNG so a failure is reproducible.
  let seed = 0x5eed;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
  };

  it('on thousands of random strings', () => {
    for (let n = 0; n < 5000; n++) {
      const len = Math.floor(rand() * 24);
      let s = '';
      for (let k = 0; k < len; k++) s += alphabet[Math.floor(rand() * alphabet.length)]!;
      expect(joinLayoutBreaks(s), JSON.stringify(s)).toBe(referenceJoin(s));
    }
  });

  it('on edge shapes', () => {
    for (const s of ['', '\n', ' \n ', '\na', 'a\n', '́\nก', 'a\ń\nb', '😀\nก', 'ก\n\uDE00']) {
      expect(joinLayoutBreaks(s), JSON.stringify(s)).toBe(referenceJoin(s));
    }
  });
});

describe('joinLayoutBreaks stays linear', () => {
  // The regex took 4.6 s on 64,000 spaces and ~0.4 s on 8,000 lines.
  it('on a long run of spaces with no line break', () => {
    const s = `a${' '.repeat(64_000)}b`;
    const t = performance.now();
    expect(joinLayoutBreaks(s)).toBe(s);
    expect(performance.now() - t).toBeLessThan(100);
  });

  it('on many line breaks', () => {
    const s = 'ก\n'.repeat(64_000);
    const t = performance.now();
    expect(joinLayoutBreaks(s)).toBe('ก'.repeat(64_000));
    expect(performance.now() - t).toBeLessThan(100);
  });

  it('on a long run of combining marks before each break', () => {
    const s = `ก${'่'.repeat(32_000)}\nข\nค`;
    const t = performance.now();
    joinLayoutBreaks(s);
    expect(performance.now() - t).toBeLessThan(100);
  });
});
