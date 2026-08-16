import { PROFILE_HOSTS } from '../content/site-profiles';
import {
  type CacheLimits,
  DEFAULT_CACHE_BYTES,
  DEFAULT_CACHE_PAGES,
  normalizeCacheLimits,
} from '../core/cache-budget';
import { clampOpacity } from '../core/panel-shape';
import { DETECT_POSTPROCESS } from '../core/preprocess';
import { clampLookahead, DEFAULT_LOOKAHEAD } from '../core/prefetch';
import { clampInFlight, DEFAULT_MAX_IN_FLIGHT } from '../core/scheduling';
import type { ApiKeyEntry } from '../core/quota';
import type { PresetName } from '../core/resolution';
import { normalizeSiteList } from '../core/site-scope';
import type { SourceLang, TargetLang } from './lang';
import type { LangCode } from '../types';

export type { ApiKeyEntry };

/**
 * All persisted settings, in chrome.storage.local only.
 *
 * Not `sync`: the API key would then travel between the user's machines
 * automatically, and sync caps a single item at 8 KB, which `perSet` will
 * eventually exceed on its own.
 */
export interface Settings {
  /**
   * Bumped whenever a migration is needed. See hydrate().
   *
   * 1 -> 2: `gemini.apiKey` (one string) became `gemini.keys` (an ordered list).
   * 2 -> 3: `autoTranslate` (one global boolean) became `autoSites` (a list of
   *         hostnames), because one switch governing every site in the browser
   *         spent quota on pages nobody asked about.
   * 3 -> 4: `cache` appeared. Nothing to carry: the budget it replaces was a
   *         constant in cache/stores.ts, never a stored value, so every
   *         existing record simply gains the defaults.
   * 4 -> 5: `display.boxOpacity` (one value for one element) became
   *         `plateOpacity` and `panelOpacity`, because the element was doing two
   *         jobs that want opposite settings. Both inherit the old value, so the
   *         upgrade changes nothing on screen until the reader moves a slider.
   * 5 -> 6: `translation.modelGrouping` becomes opt-in and is forced off once.
   *         It shipped on by default in D-036 and merged three separate speech
   *         balloons into one translation on the owner's page, so every stored
   *         `true` written before this version is the old default speaking, not
   *         a reader's decision, and is not worth honouring.
   */
  version: 6;

  /**
   * The master kill switch, and the only thing here that is still global.
   *
   * Off means the extension does nothing anywhere, including the right-click
   * menu. It is deliberately not per-site: "stop everything" has to be reachable
   * without first working out which site you are on.
   */
  enabled: boolean;

  /**
   * Hostnames where translation happens on its own, canonical form (see
   * core/site-scope.ts).
   *
   * A list of the sites that are **on**; anything not in it is off. Empty is the
   * fresh-install state and means nothing happens automatically anywhere — the
   * right-click menu and "แปลหน้านี้เดี๋ยวนี้" still work everywhere, because
   * those are the reader asking, once, for one page.
   */
  autoSites: string[];

  lang: {
    source: SourceLang;
    target: TargetLang;
  };

  translation: {
    mode: 'cloud' | 'local' | 'auto';
    gemini: {
      /**
       * The user's own keys, in priority order. Never a developer key — see
       * INSTALL.md.
       *
       * A list rather than one string because the free tier meters 1,000
       * requests per key per day: a second key is a second day of reading, and
       * "first until it runs out, then the next" is the only ordering that
       * makes a spare behave like a spare. Rotation lives in
       * translation/KeyRing.ts; the rules are in core/quota.ts.
       */
      keys: ApiKeyEntry[];
      model: string;
      safetyOff: boolean;
    };
    /**
     * Ollama is M6 work and disabled today, but the fields exist now so turning
     * it on later is a UI change rather than a storage migration for everyone
     * who already installed.
     */
    ollama: {
      enabled: boolean;
      baseUrl: string;
      model: string;
      numCtx: number;
      timeoutMs: number;
    };
    contextBubbles: number;
    /**
     * Let the model say which detected blocks are fragments of one continuous
     * text, so a sentence split across several columns is translated whole.
     *
     * **Off unless the reader asks for it.** It shipped on by default in D-036
     * behind a geometric veto (core/merge-proposals.ts), and the veto let a real
     * page through: three separate speech balloons in one panel became a single
     * block, so one balloon's Thai was stretched over all three and the other two
     * went untranslated. A feature whose failure mode is putting one character's
     * words in another character's mouth has to be opted into — the reader cannot
     * see it happen, which is exactly why the default cannot be the risky one.
     *
     * The reply still carries one item per crop either way, so off is the
     * previous behaviour exactly, at no cost.
     */
    modelGrouping: boolean;
  };

  ocr: {
    runtime: 'auto' | 'webgpu' | 'wasm';
    preset: PresetName;
    /** Detector mask dilation. Exposed because it is the main recall/merge lever. */
    dilateRatio: number;
  };

  display: {
    mode: 'target-only' | 'target-plus-source-on-hover';
    fontScale: number;
    /**
     * The cover plate: the *detected* rectangle, hugging the original ink.
     *
     * Its only job is hiding the source text, so it wants to be small and
     * opaque. Kept separate from the panel below because the panel is widened
     * for horizontal Thai (core/panel-shape.ts) and widening the plate with it
     * meant a readable line of Thai was paid for with a white slab across the
     * artwork.
     */
    plateOpacity: number;
    /**
     * The text panel: the widened rectangle the Thai is set in.
     *
     * Wants to be as faint as it can be and still read, so the picture shows
     * through behind the words. Where the two rects coincide — horizontal
     * source text, which is not widened at all — the stack is painted at
     * whichever of the two is stronger rather than both, see `plateAlphaOver`.
     */
    panelOpacity: number;
    /**
     * Hovering a translation panel fades it so the artwork underneath shows.
     *
     * On by default: a panel that is bigger than the text it replaced hides art
     * the reader wanted, and a reader who cannot see the art has no way to
     * guess that a hover would reveal it. Costs nothing when the mouse is
     * elsewhere — the panels stay non-interactive either way, see
     * content/overlay/overlay.ts.
     */
    peekOnHover: boolean;
  };

  performance: {
    /**
     * Pages to translate ahead of the reader. 0 disables it.
     *
     * Capped at MAX_LOOKAHEAD, which is deliberately large enough to express
     * "the whole chapter" — the politeness rules that bound the *rate* live in
     * core/prefetch.ts and do not read this value at all. The default and why
     * it moved are documented there too, on DEFAULT_LOOKAHEAD.
     */
    prefetchLookahead: number;
    /**
     * Locked at 1: ONNX sessions are not re-entrant (D-013), so two detections
     * at once fail outright. This has never been about jank.
     */
    maxConcurrentOcr: 1;
    /**
     * Whole jobs in flight at once.
     *
     * Separate from `maxConcurrentOcr` because they bound different things, and
     * conflating them is what limited throughput to 2 images/minute: a job is
     * 126-481 ms of detection and 1.3-41 s of waiting on Gemini, and only the
     * first of those has to happen alone. See core/scheduling.ts.
     */
    maxConcurrentRequests: number;
  };

  /**
   * How much reading to keep. Rules and clamping in core/cache-budget.ts.
   *
   * Pages first, because that is the unit the question comes in — "does a
   * chapter fit?" — and megabytes cannot answer it. The byte ceiling stays
   * underneath as the actual guard on disk, since a page count on its own says
   * nothing about how big a page turns out to be.
   */
  cache: CacheLimits;

  /**
   * Remembered per gallery/series, so an auto-detected language is paid for once.
   *
   * `source` is the working language; the two fields under it are the evidence
   * behind it. Keeping the evidence rather than only the verdict is what stops a
   * gallery whose pages are genuinely mixed from overwriting its own memory on
   * every page and buying a re-read each time — see core/lang-memory.ts.
   *
   * All optional, and absent on every record written before they existed, which
   * is why they need no migration: an old record simply has no evidence yet and
   * starts accumulating it on the next page read.
   */
  perSet: Record<
    string,
    {
      source?: SourceLang;
      enabled?: boolean;
      /** Pages of this set that read as each script. */
      langCounts?: Partial<Record<LangCode, number>>;
      /** Re-reads already spent correcting this set's language. */
      langRereads?: number;
    }
  >;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 6,
  enabled: true,
  autoSites: [],
  lang: { source: 'ja', target: 'th' },
  translation: {
    mode: 'cloud',
    gemini: {
      keys: [],
      // Alias, never a pinned point release: gemini-2.5-flash-lite already
      // returns 404 "no longer available to new users", and this is going to be
      // installed by friends who will not know why it broke.
      model: 'gemini-flash-lite-latest',
      safetyOff: true,
    },
    ollama: {
      enabled: false,
      baseUrl: 'http://localhost:11434',
      model: '',
      numCtx: 8192,
      timeoutMs: 60_000,
    },
    contextBubbles: 3,
    modelGrouping: false,
  },
  ocr: { runtime: 'auto', preset: 'balanced', dilateRatio: DETECT_POSTPROCESS.dilateRatio },
  display: {
    // 'target-only', not the source-on-hover variant: hovering is for looking at
    // the picture, and swapping one block of text for another leaves the art
    // just as hidden. Anyone who wants the Japanese can still turn it on.
    mode: 'target-only',
    fontScale: 1,
    // Fully opaque, because hiding the original is the whole of this layer's
    // job and 0.92 leaves the Japanese faintly legible under the Thai.
    plateOpacity: 1,
    // Not opaque, because this layer is mostly artwork: on vertical text it is
    // several times the width of the ink it replaced. A fresh install therefore
    // shows the art around the words straight away, rather than hiding it and
    // waiting for the reader to discover a slider.
    panelOpacity: 0.8,
    peekOnHover: true,
  },
  performance: {
    prefetchLookahead: DEFAULT_LOOKAHEAD,
    maxConcurrentOcr: 1,
    maxConcurrentRequests: DEFAULT_MAX_IN_FLIGHT,
  },
  cache: { maxPages: DEFAULT_CACHE_PAGES, maxBytes: DEFAULT_CACHE_BYTES },
  perSet: {},
};

const KEY = 'settings';

/** How settings looked at version 1, for the migration below. */
interface LegacyGemini {
  apiKey?: unknown;
  keys?: unknown;
}

/**
 * v1 -> v2: one `apiKey` string becomes an ordered `keys` list.
 *
 * The upgrade must carry the key the user already pasted into the first slot.
 * Losing it means the extension silently stops translating and the only clue is
 * an empty field on a settings page they have not opened in weeks.
 *
 * Gated on the stored version rather than on `keys` being empty, because after
 * the migration an empty list is a legitimate state — the user deleted their
 * last key — and resurrecting the old string there would make deletion
 * impossible.
 */
function migrateKeys(version: unknown, raw: LegacyGemini | undefined): ApiKeyEntry[] {
  const listed = Array.isArray(raw?.keys)
    ? raw.keys.filter(isKeyEntry).map((k) => ({ id: k.id, label: k.label, key: k.key }))
    : [];
  if (listed.length > 0 || Number(version) >= 2) return listed;

  const legacy = typeof raw?.apiKey === 'string' ? raw.apiKey.trim() : '';
  return legacy ? [{ id: 'legacy-1', label: 'key เดิม', key: legacy }] : [];
}

/**
 * v2 -> v3: one global `autoTranslate` becomes a list of hostnames.
 *
 * Neither obvious answer is acceptable on its own. Migrating everyone to "off
 * everywhere" silently breaks a working setup: the reader updates, opens their
 * manga site, nothing happens, and there is nothing on screen explaining why.
 * Migrating to "on everywhere" is impossible — that global is precisely the bug.
 *
 * So: a reader who had it on keeps it on for the hostnames a site profile was
 * written for (see content/site-profiles.ts) and gets it off everywhere else.
 * Those are the only places auto-translate was ever aimed at, so their reading
 * survives the upgrade untouched while every unrelated tab stops costing them
 * requests. A reader who had it off gets an empty list, which is the same thing
 * they had.
 *
 * Gated on the stored version, like the key migration above and for the same
 * reason: after the upgrade an empty list is a decision — the reader switched
 * their last site off — and re-seeding it there would make that undoable.
 */
function migrateAutoSites(version: unknown, stored: unknown, legacyOn: unknown): string[] {
  const listed = normalizeSiteList(stored);
  if (listed.length > 0 || Number(version) >= 3) return listed;
  return legacyOn === true ? normalizeSiteList(PROFILE_HOSTS) : [];
}

/**
 * v4 -> v5: one `boxOpacity` becomes a plate opacity and a panel opacity.
 *
 * Both inherit the old number. That is deliberately a visual no-op: over the
 * plate the two layers composite to `max(plate, panel)` (see `plateAlphaOver`),
 * which is the old value, and outside it the panel alone is the old value too.
 * So the reader's page looks exactly as it did after the upgrade, and the new
 * behaviour only appears once they move one of the two sliders — which is the
 * only honest way to introduce a setting nobody has an opinion about yet.
 *
 * Gated on the stored version, like the two migrations above and for the same
 * reason: once the record says 5, whatever is in the two fields is a decision.
 */
function migrateDisplay(
  version: unknown,
  stored: (Partial<Settings['display']> & { boxOpacity?: unknown }) | undefined,
): Pick<Settings['display'], 'plateOpacity' | 'panelOpacity'> {
  const d = DEFAULT_SETTINGS.display;
  if (Number(version) >= 5) {
    return {
      plateOpacity: clampOpacity(stored?.plateOpacity ?? d.plateOpacity),
      panelOpacity: clampOpacity(stored?.panelOpacity ?? d.panelOpacity),
    };
  }
  const legacy = typeof stored?.boxOpacity === 'number' ? clampOpacity(stored.boxOpacity) : null;
  if (legacy === null) return { plateOpacity: d.plateOpacity, panelOpacity: d.panelOpacity };
  return { plateOpacity: legacy, panelOpacity: legacy };
}

/**
 * v5 -> v6: model-proposed grouping becomes opt-in, and every existing record
 * is switched off once.
 *
 * Not gated the way the migrations above are, and the difference is the point.
 * Those carry a reader's choice forward. This one deliberately discards a stored
 * value, because a `true` written before v6 is not a choice: `DEFAULT_SETTINGS`
 * said `true`, `hydrate` copies defaults into the record on the next write, and
 * so everyone who ever opened the settings page has a `true` in storage whether
 * or not they have heard of the feature. Honouring that would leave the failure
 * D-037 is about switched on for exactly the people who never asked for it.
 *
 * The cost is one checkbox for anyone who did turn it on deliberately. The
 * alternative cost is one character's line printed inside another character's
 * balloon, invisibly, on a page they are reading.
 */
function migrateModelGrouping(version: unknown, stored: unknown): boolean {
  if (Number(version) < 6) return false;
  return stored === true;
}

function isKeyEntry(v: unknown): v is ApiKeyEntry {
  const e = v as ApiKeyEntry | null;
  return (
    typeof e?.id === 'string' && e.id !== '' && typeof e.key === 'string' && typeof e.label === 'string'
  );
}

/**
 * Deep-merge stored values over defaults so a new field never reads undefined.
 *
 * Exported for tests: the v1 -> v2 key migration runs exactly once on a real
 * user's machine and there is no second chance to get it right.
 */
export function hydrate(stored: unknown): Settings {
  const s = (stored ?? {}) as Partial<Settings> & { autoTranslate?: unknown };
  const d = DEFAULT_SETTINGS;
  const gemini = s.translation?.gemini as (Partial<Settings['translation']['gemini']> & LegacyGemini) | undefined;
  const display = s.display as (Partial<Settings['display']> & { boxOpacity?: unknown }) | undefined;
  const next: Settings & { autoTranslate?: unknown; display: Settings['display'] & { boxOpacity?: unknown } } = {
    ...d,
    ...s,
    version: 6,
    // Normalised on read, not only on write: this list decides which sites are
    // allowed to spend the reader's daily quota, so a hand-edited storage entry
    // must not be able to add a site under a spelling the popup cannot show.
    autoSites: migrateAutoSites(s.version, s.autoSites, s.autoTranslate),
    lang: { ...d.lang, ...s.lang },
    translation: {
      ...d.translation,
      ...s.translation,
      // Built field by field rather than spread, so the v1 `apiKey` is dropped
      // from storage on the next write instead of leaving a second copy of a
      // secret lying around forever.
      gemini: {
        keys: migrateKeys(s.version, gemini),
        model: gemini?.model ?? d.translation.gemini.model,
        safetyOff: gemini?.safetyOff ?? d.translation.gemini.safetyOff,
      },
      ollama: { ...d.translation.ollama, ...s.translation?.ollama },
      modelGrouping: migrateModelGrouping(s.version, s.translation?.modelGrouping),
    },
    ocr: { ...d.ocr, ...s.ocr },
    // Clamped on read like the lists and budgets above: an alpha outside [0,1]
    // is not a setting, and a record that has gone wrong must fail towards
    // hiding the original rather than towards showing untranslated Japanese.
    display: { ...d.display, ...s.display, ...migrateDisplay(s.version, display) },
    performance: {
      ...d.performance,
      ...s.performance,
      maxConcurrentOcr: 1,
      // Clamped on read, not only on write: these values decide how many
      // requests go to someone else's server, and a hand-edited storage entry
      // must not be able to raise them.
      prefetchLookahead: clampLookahead(s.performance?.prefetchLookahead ?? d.performance.prefetchLookahead),
      maxConcurrentRequests: clampInFlight(
        s.performance?.maxConcurrentRequests ?? d.performance.maxConcurrentRequests,
      ),
    },
    // v3 -> v4 is just this line: a record saved before the setting existed has
    // no `cache` field, and normalize fills in both halves. Clamped on read for
    // the same reason as the two above — and with one extra: the page floor is
    // what keeps this setting from contradicting prefetchLookahead, so a
    // hand-edited storage entry must not be able to get underneath it.
    cache: normalizeCacheLimits(s.cache),
    perSet: { ...d.perSet, ...s.perSet },
  };
  // The `...s` spreads above copy the dead v2 and v4 fields through. Deleting
  // them means the next write drops them from storage instead of leaving stale
  // values that look authoritative to anyone reading the record later — and, in
  // `boxOpacity`'s case, would silently re-run the migration over the reader's
  // new choices if the version were ever rolled back.
  delete next.autoTranslate;
  delete next.display.boxOpacity;
  return next;
}

export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(KEY);
  return hydrate(got[KEY]);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = hydrate({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** Fires on any settings write, including from another extension page. */
export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName,
  ) => {
    if (area === 'local' && changes[KEY]) cb(hydrate(changes[KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
