import { describe, expect, it } from 'vitest';
import { PROFILE_HOSTS } from '../content/site-profiles';
import {
  DEFAULT_CACHE_BYTES,
  DEFAULT_CACHE_PAGES,
  MIN_CACHE_PAGES,
} from '../core/cache-budget';
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
    expect(s.version).toBe(6);
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
    expect(s.display.plateOpacity).toBe(DEFAULT_SETTINGS.display.plateOpacity);
    expect(s.display.panelOpacity).toBe(DEFAULT_SETTINGS.display.panelOpacity);
    expect(s.translation.gemini.safetyOff).toBe(false);
  });

  it('handles storage that is empty or garbage', () => {
    expect(hydrate(undefined).translation.gemini.keys).toEqual([]);
    expect(hydrate(null).version).toBe(6);
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
    expect(s.version).toBe(6);
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
    expect(s.version).toBe(6);
    expect(s.translation.gemini.keys[0]?.key).toBe('AIza-x');
    expect(s.autoSites).toContain('imhentai.xxx');
  });

  it('leaves the global kill switch global', () => {
    expect(hydrate({ version: 2, enabled: false, autoTranslate: true }).enabled).toBe(false);
  });
});

/**
 * v3 -> v4 carries nothing, which is exactly why it needs tests: the risk in a
 * migration that only adds a field is not the new field, it is the version bump
 * silently taking something else with it. The owner is running v3 right now with
 * real keys and a per-site list, so what is checked here is mostly that those
 * survive untouched.
 */
describe('hydrate — v3 to v4, a cache budget the reader can set', () => {
  it('does not cost a v3 reader their keys or their sites', () => {
    const s = hydrate({
      version: 3,
      enabled: true,
      autoSites: ['imhentai.xxx', 'mangadex.org'],
      translation: { gemini: { keys: [{ id: 'a', label: 'หลัก', key: 'AIza-real' }] } },
      perSet: { 'imhentai.xxx/1474885': { source: 'ja' } },
    });
    expect(s.version).toBe(6);
    expect(s.translation.gemini.keys).toEqual([{ id: 'a', label: 'หลัก', key: 'AIza-real' }]);
    expect(s.autoSites).toEqual(['imhentai.xxx', 'mangadex.org']);
    expect(s.perSet['imhentai.xxx/1474885']).toEqual({ source: 'ja' });
  });

  it('gives a record written before the setting existed the defaults', () => {
    expect(hydrate({ version: 3 }).cache).toEqual({
      maxPages: DEFAULT_CACHE_PAGES,
      maxBytes: DEFAULT_CACHE_BYTES,
    });
  });

  it('keeps a budget the reader has already chosen', () => {
    expect(hydrate({ version: 4, cache: { maxPages: 40, maxBytes: 50 * 1024 * 1024 } }).cache).toEqual({
      maxPages: 40,
      maxBytes: 50 * 1024 * 1024,
    });
  });

  it('will not let a hand-edited record hold less than prefetch reads ahead', () => {
    // Not a warning, a floor: a cache below the lookahead throws away pages that
    // were translated for a reader who has not reached them yet.
    expect(hydrate({ version: 4, cache: { maxPages: 2 } }).cache.maxPages).toBe(MIN_CACHE_PAGES);
    expect(MIN_CACHE_PAGES).toBeGreaterThan(DEFAULT_SETTINGS.performance.prefetchLookahead);
  });

  it('survives a cache field that is not an object', () => {
    expect(hydrate({ version: 4, cache: 'lots' }).cache.maxPages).toBe(DEFAULT_CACHE_PAGES);
    expect(hydrate({ version: 4, cache: null }).cache.maxBytes).toBe(DEFAULT_CACHE_BYTES);
  });

  it('takes a v1 all the way to v4 with every migration applied', () => {
    const s = hydrate({
      version: 1,
      autoTranslate: true,
      translation: { gemini: { apiKey: 'AIza-x' } },
    });
    expect(s.version).toBe(6);
    expect(s.translation.gemini.keys[0]?.key).toBe('AIza-x');
    expect(s.autoSites).toContain('mangadex.org');
    expect(s.cache.maxPages).toBe(DEFAULT_CACHE_PAGES);
  });
});

/**
 * v4 -> v5 splits one opacity into two. The owner is running this build with
 * real keys, real per-site switches and a boxOpacity they chose, so what is
 * checked here is that the upgrade costs them none of it and does not silently
 * restyle the page they are reading.
 */
describe('hydrate — v4 to v5, one box opacity becomes a plate and a panel', () => {
  it('gives both layers the value the reader already chose', () => {
    // Deliberately a visual no-op: over the plate the two composite to
    // max(plate, panel) and outside it the panel alone is that same number, so
    // the page looks exactly as it did until a slider moves.
    const s = hydrate({ version: 4, display: { boxOpacity: 0.6 } });
    expect(s.display.plateOpacity).toBe(0.6);
    expect(s.display.panelOpacity).toBe(0.6);
  });

  it('carries the owner’s keys, sites and cache across the bump', () => {
    const s = hydrate({
      version: 4,
      autoSites: ['e-hentai.org', 'nhentai.net'],
      translation: { gemini: { keys: [{ id: 'a', label: 'หลัก', key: 'AIza-real' }] } },
      cache: { maxPages: 60, maxBytes: 100 * 1024 * 1024 },
      display: { boxOpacity: 0.92, fontScale: 1.1, peekOnHover: false },
      perSet: { 'e-hentai.org/4118730': { source: 'ja' } },
    });
    expect(s.version).toBe(6);
    expect(s.translation.gemini.keys).toEqual([{ id: 'a', label: 'หลัก', key: 'AIza-real' }]);
    expect(s.autoSites).toEqual(['e-hentai.org', 'nhentai.net']);
    expect(s.cache).toEqual({ maxPages: 60, maxBytes: 100 * 1024 * 1024 });
    expect(s.display.fontScale).toBe(1.1);
    expect(s.display.peekOnHover).toBe(false);
    expect(s.perSet['e-hentai.org/4118730']).toEqual({ source: 'ja' });
  });

  it('drops the dead field so it cannot overwrite the new ones later', () => {
    const s = hydrate({ version: 4, display: { boxOpacity: 0.6 } });
    expect((s.display as unknown as Record<string, unknown>).boxOpacity).toBeUndefined();
  });

  it('gives the defaults to a record that never had the old field', () => {
    expect(hydrate({ version: 4 }).display.plateOpacity).toBe(DEFAULT_SETTINGS.display.plateOpacity);
    expect(hydrate({ version: 4 }).display.panelOpacity).toBe(DEFAULT_SETTINGS.display.panelOpacity);
  });

  it('does not undo the reader’s choice once they have made one', () => {
    // Storage may still hold the v4 number. Once the version says 5, the two
    // fields are decisions, and re-deriving them from the old one would make
    // "plate solid, panel faint" impossible to keep.
    const s = hydrate({
      version: 5,
      display: { boxOpacity: 0.92, plateOpacity: 1, panelOpacity: 0.15 },
    });
    expect(s.display.plateOpacity).toBe(1);
    expect(s.display.panelOpacity).toBe(0.15);
  });

  it('refuses an alpha outside [0,1] from a hand-edited record', () => {
    const s = hydrate({ version: 5, display: { plateOpacity: 4, panelOpacity: -2 } });
    expect(s.display.plateOpacity).toBe(1);
    expect(s.display.panelOpacity).toBe(0);
    expect(hydrate({ version: 5, display: { plateOpacity: 'solid' } }).display.plateOpacity).toBe(1);
  });

  it('takes a v1 all the way to v6', () => {
    const s = hydrate({ version: 1, translation: { gemini: { apiKey: 'AIza-x' } } });
    expect(s.version).toBe(6);
    expect(s.translation.gemini.keys[0]?.key).toBe('AIza-x');
    expect(s.display.plateOpacity).toBe(DEFAULT_SETTINGS.display.plateOpacity);
  });
});

/**
 * The one migration in this file that throws a stored value away on purpose.
 *
 * Every other one carries the reader's choice forward. This one cannot: before
 * v6 the default was `true` and `hydrate` writes defaults into the record, so a
 * stored `true` is indistinguishable from the old default and mostly *is* it —
 * and leaving it on means the reader keeps a feature that merged three speech
 * balloons into one translation without ever choosing to have it.
 */
describe('hydrate — v5 to v6 model grouping becomes opt-in', () => {
  it('is off on a fresh install', () => {
    expect(hydrate(null).translation.modelGrouping).toBe(false);
    expect(DEFAULT_SETTINGS.translation.modelGrouping).toBe(false);
  });

  it('switches off a record that carried the old on-by-default true', () => {
    const s = hydrate({ version: 5, translation: { modelGrouping: true } });
    expect(s.translation.modelGrouping).toBe(false);
  });

  it('switches off a record from before the field existed', () => {
    expect(hydrate({ version: 4 }).translation.modelGrouping).toBe(false);
  });

  it('keeps the reader’s choice once the record is v6', () => {
    expect(hydrate({ version: 6, translation: { modelGrouping: true } }).translation.modelGrouping)
      .toBe(true);
    expect(hydrate({ version: 6, translation: { modelGrouping: false } }).translation.modelGrouping)
      .toBe(false);
    expect(hydrate({ version: 6 }).translation.modelGrouping).toBe(false);
  });

  it('reads anything that is not exactly true as off', () => {
    for (const v of ['true', 1, {}, null]) {
      expect(hydrate({ version: 6, translation: { modelGrouping: v } }).translation.modelGrouping)
        .toBe(false);
    }
  });
});
