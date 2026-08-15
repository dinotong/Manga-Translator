import { clampLookahead } from '../core/prefetch';
import type { ApiKeyEntry } from '../core/quota';
import type { PresetName } from '../core/resolution';
import type { SourceLang, TargetLang } from './lang';

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
   */
  version: 2;

  enabled: boolean;
  /** false = nothing happens until the user asks for it (right-click / popup). */
  autoTranslate: boolean;

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
    boxOpacity: number;
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
    /** Pages to translate ahead of the reader. 0 disables it; capped at 10. */
    prefetchLookahead: number;
    /** Locked at 1: detection is CPU/GPU bound and parallelism only adds jank. */
    maxConcurrentOcr: 1;
  };

  /** Remembered per gallery/series, so an auto-detected language is paid for once. */
  perSet: Record<string, { source?: SourceLang; enabled?: boolean }>;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 2,
  enabled: true,
  autoTranslate: false,
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
  },
  ocr: { runtime: 'auto', preset: 'balanced', dilateRatio: 0.01 },
  display: {
    // 'target-only', not the source-on-hover variant: hovering is for looking at
    // the picture, and swapping one block of text for another leaves the art
    // just as hidden. Anyone who wants the Japanese can still turn it on.
    mode: 'target-only',
    fontScale: 1,
    boxOpacity: 0.92,
    peekOnHover: true,
  },
  performance: { prefetchLookahead: 3, maxConcurrentOcr: 1 },
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
  const s = (stored ?? {}) as Partial<Settings>;
  const d = DEFAULT_SETTINGS;
  const gemini = s.translation?.gemini as (Partial<Settings['translation']['gemini']> & LegacyGemini) | undefined;
  return {
    ...d,
    ...s,
    version: 2,
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
    },
    ocr: { ...d.ocr, ...s.ocr },
    display: { ...d.display, ...s.display },
    performance: {
      ...d.performance,
      ...s.performance,
      maxConcurrentOcr: 1,
      // Clamped on read, not only on write: this value decides how many requests
      // go to someone else's server, and a hand-edited storage entry must not be
      // able to raise it.
      prefetchLookahead: clampLookahead(s.performance?.prefetchLookahead ?? d.performance.prefetchLookahead),
    },
    perSet: { ...d.perSet, ...s.perSet },
  };
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
