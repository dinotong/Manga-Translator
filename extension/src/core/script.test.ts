import { describe, expect, it } from 'vitest';
import { detectScript, MIN_SCRIPT_CHARS } from './script';

/**
 * The measurement behind this: the owner's English chapter read as `ja` gave 9
 * blocks, 8 of them called vertical; the same page read as `en` gave 12, none
 * vertical, and was dramatically better. `auto` resolving silently to `ja` is
 * what put every reader on the first of those.
 */
describe('detectScript', () => {
  it('reads English comic lettering as English', () => {
    expect(detectScript("WHERE'D HE GO? HE WENT THAT WAY! ARE YOU SURE ABOUT THAT?")).toBe('en');
  });

  it('reads Japanese dialogue as Japanese', () => {
    expect(detectScript('おはようございます。今日はいい天気ですね、先輩。')).toBe('ja');
  });

  it('calls kanji-heavy Japanese Japanese, not Chinese', () => {
    // Han counts towards Japanese as soon as any kana is present. Without that,
    // a line that is mostly compounds with two trailing kana reads as Chinese
    // and the whole gallery is remembered under the wrong language.
    expect(detectScript('本日午後三時、東京駅前の喫茶店で待ち合わせをした。')).toBe('ja');
  });

  it('calls Han with no kana at all Chinese', () => {
    expect(detectScript('今天天氣很好我們一起去公園散步好不好')).toBe('zh');
  });

  it('reads Hangul as Korean', () => {
    expect(detectScript('안녕하세요 오늘 날씨가 정말 좋네요 같이 산책 할까요')).toBe('ko');
  });

  it('is not fooled by a Latin name inside a Japanese page', () => {
    expect(detectScript('マリアさんはどこへ行ったの。Maria。だれか知らない？')).toBe('ja');
  });

  it('says nothing rather than guessing from too little text', () => {
    expect(detectScript('!?')).toBeNull();
    expect(detectScript('')).toBeNull();
    expect(detectScript('OH!')).toBeNull();
    expect(detectScript('あ')).toBeNull();
  });

  it('counts only scripted characters, so punctuation cannot reach the floor', () => {
    expect(detectScript('!?!?!?!?!?!?!?!?!?!?!?!?!?!?!?!?!?!?')).toBeNull();
    expect(detectScript('12345678901234567890 ... --- !!!')).toBeNull();
  });

  it('says nothing when no script holds a clear majority', () => {
    // Half and half is exactly the case where remembering an answer for a whole
    // gallery would be worse than keeping the guess and asking again next page.
    expect(detectScript('あいうえおかきくけこ ABCDEFGHIJ')).toBeNull();
  });

  it('needs the floor met in scripted characters, not in string length', () => {
    const short = 'ABCDEFGHIJ'; // 10 < MIN_SCRIPT_CHARS
    expect(short.length).toBeLessThan(MIN_SCRIPT_CHARS);
    expect(detectScript(short)).toBeNull();
    expect(detectScript(`${short}KLMNOP`)).toBe('en');
  });

  it('survives text that is nothing but emoji and spaces', () => {
    expect(detectScript('🙂 🙃 😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌')).toBeNull();
  });
});
