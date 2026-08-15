import { describe, expect, it } from 'vitest';
import { PROFILE_HOSTS } from '../content/site-profiles';
import { DEFAULT_SETTINGS, hydrate } from './settings';

/**
 * The migration only ever runs once per installed copy, so a bug here is not
 * "the tests were red for a bit" — it is the owner opening the extension after
 * an update and finding their API key gone.
 */
describe('hydrate — v1 to v2 key migration', () => {
  it('carries a v1 apiKey into the first slot of the new list', () => {
    const s = hydrate({
      version: 1,
      translation: { gemini: { apiKey: 'AIza-real-key', model: 'gemini-flash-lite-latest' } },
    });
    expect(s.version).toBe(3);
    expect(s.translation.gemini.keys).toHaveLength(1);
    expect(s.translation.gemini.keys[0]?.key).toBe('AIza-real-key');
    expect(s.translation.gemini.model).toBe('gemini-flash-lite-latest');
  });

  it('trims a key pasted with surrounding whitespace', () => {
    const s = hydrate({ version: 1, translation: { gemini: { apiKey: '  AIza-x\n' } } });
    expect(s.translation.gemini.keys[0]?.key).toBe('AIza-x');
  });

  it('produces an empty list, not a blank key, when v1 had none', () => {
    expect(hydrate({ version: 1, translation: { gemini: { apiKey: '' } } }).translation.gemini.keys)
      .toEqual([]);
  });

  it('drops the v1 field so a second copy of the secret is not left behind', () => {
    const s = hydrate({ version: 1, translation: { gemini: { apiKey: 'AIza-x' } } });
    expect((s.translation.gemini as Record<string, unknown>).apiKey).toBeUndefined();
  });

  it('does not resurrect the old key after the user deletes their last one', () => {
    // Storage still holds the v1 string until it is overwritten. Once the
    // version says 2, an empty list is a decision, not a missing value.
    const s = hydrate({
      version: 2,
      translation: { gemini: { apiKey: 'AIza-old', keys: [] } },
    });
    expect(s.translation.gemini.keys).toEqual([]);
  });

  it('leaves an already-migrated list alone, in order', () => {
    const keys = [
      { id: 'a', label: 'หลัก', key: 'AIza-a' },
      { id: 'b', label: 'สำรอง', key: 'AIza-b' },
    ];
    expect(hydrate({ version: 2, translation: { gemini: { keys } } }).translation.gemini.keys).toEqual(
      keys,
    );
  });

  it('ignores malformed entries rather than crashing the settings page', () => {
    const s = hydrate({
      version: 2,
      translation: { gemini: { keys: [null, { key: 'no id' }, { id: 'ok', label: 'l', key: 'k' }] } },
    });
    expect(s.translation.gemini.keys.map((k) => k.id)).toEqual(['ok']);
  });

  it('defaults peek-on-hover on for someone upgrading from v1', () => {
    expect(hydrate({ version: 1 }).display.peekOnHover).toBe(true);
  });

  it('keeps an explicit off through a reload', () => {
    expect(hydrate({ version: 2, display: { peekOnHover: false } }).display.peekOnHover).toBe(false);
  });

  it('leaves the rest of a v1 settings object intact', () => {
    const s = hydrate({
      version: 1,
      lang: { source: 'en', target: 'th' },
      ocr: { dilateRatio: 0.02 },
      display: { fontScale: 1.2 },
      translation: { gemini: { apiKey: 'AIza-x', safetyOff: false } },
    });
    expect(s.lang.source).toBe('en');
    expect(s.ocr.dilateRatio).toBe(0.02);
    expect(s.display.fontScale).toBe(1.2);
    expect(s.display.boxOpacity).toBe(DEFAULT_SETTINGS.display.boxOpacity);
    expect(s.translation.gemini.safetyOff).toBe(false);
  });

  it('handles storage that is empty or garbage', () => {
    expect(hydrate(undefined).translation.gemini.keys).toEqual([]);
    expect(hydrate(null).version).toBe(3);
    expect(hydrate({ translation: { gemini: { keys: 'nope' } } }).translation.gemini.keys).toEqual([]);
  });
});

/**
 * The one migration the owner is standing in front of: they are using v2 right
 * now with the global switch on. Getting this wrong means either their manga
 * site goes quiet after an update with nothing on screen to explain it, or the
 * exact bug they reported survives the fix.
 */
describe('hydrate — v2 to v3, global autoTranslate to a per-site list', () => {
  it('keeps the sites auto-translate was aimed at, for someone who had it on', () => {
    const s = hydrate({ version: 2, autoTranslate: true });
    expect(s.version).toBe(3);
    expect(s.autoSites).toEqual([...PROFILE_HOSTS]);
    expect(s.autoSites).toContain('imhentai.xxx');
    expect(s.autoSites).toContain('mangadex.org');
  });

  it('does not switch on the whole browser — the reported bug must not survive', () => {
    const s = hydrate({ version: 2, autoTranslate: true });
    expect(s.autoSites).not.toContain('wikipedia.org');
    expect(s.autoSites).not.toContain('*');
    expect(s.autoSites.length).toBeLessThan(10);
  });

  it('gives an empty list to someone who had it off', () => {
    expect(hydrate({ version: 2, autoTranslate: false }).autoSites).toEqual([]);
    expect(hydrate({ version: 2 }).autoSites).toEqual([]);
  });

  it('is off everywhere on a fresh install', () => {
    expect(DEFAULT_SETTINGS.autoSites).toEqual([]);
    expect(hydrate({}).autoSites).toEqual([]);
  });

  it('does not re-seed after the reader removes their last site', () => {
    // Storage still carries the v2 boolean until it is overwritten. Once the
    // version says 3, an empty list is a decision, not a missing value.
    const s = hydrate({ version: 3, autoTranslate: true, autoSites: [] });
    expect(s.autoSites).toEqual([]);
  });

  it('drops the dead v2 field so no stale global is left in storage', () => {
    const s = hydrate({ version: 2, autoTranslate: true });
    expect((s as unknown as Record<string, unknown>).autoTranslate).toBeUndefined();
  });

  it('leaves an already-migrated list alone', () => {
    expect(hydrate({ version: 3, autoSites: ['imhentai.xxx'] }).autoSites).toEqual(['imhentai.xxx']);
  });

  it('canonicalises a hand-edited list on the way in', () => {
    const s = hydrate({ version: 3, autoSites: ['WWW.MangaDex.org', 'mangadex.org', 7] });
    expect(s.autoSites).toEqual(['mangadex.org']);
  });

  it('survives a list that is not a list', () => {
    expect(hydrate({ version: 3, autoSites: 'imhentai.xxx' }).autoSites).toEqual([]);
    expect(hydrate({ version: 3, autoSites: null }).autoSites).toEqual([]);
  });

  it('takes a v1 straight to v3, carrying both migrations', () => {
    const s = hydrate({
      version: 1,
      autoTranslate: true,
      translation: { gemini: { apiKey: 'AIza-x' } },
    });
    expect(s.version).toBe(3);
    expect(s.translation.gemini.keys[0]?.key).toBe('AIza-x');
    expect(s.autoSites).toContain('imhentai.xxx');
  });

  it('leaves the global kill switch global', () => {
    expect(hydrate({ version: 2, enabled: false, autoTranslate: true }).enabled).toBe(false);
  });
});
