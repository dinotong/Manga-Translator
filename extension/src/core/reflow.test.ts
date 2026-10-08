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
