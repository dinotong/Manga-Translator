import type { PresetName } from '../core/resolution';
import type { SourceLang, TargetLang } from './lang';

/**
 * All persisted settings, in chrome.storage.local only.
 *
 * Not `sync`: the API key would then travel between the user's machines
 * automatically, and sync caps a single item at 8 KB, which `perSet` will
 * eventually exceed on its own.
 */
export interface Settings {
  /** Bumped whenever a migration is needed. See migrate(). */
  version: 1;

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
      /** The user's own key. Never a developer key — see INSTALL.md. */
      apiKey: string;
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
  };

  performance: {
    prefetchLookahead: number;
    /** Locked at 1: detection is CPU/GPU bound and parallelism only adds jank. */
    maxConcurrentOcr: 1;
  };

  /** Remembered per gallery/series, so an auto-detected language is paid for once. */
  perSet: Record<string, { source?: SourceLang; enabled?: boolean }>;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  enabled: true,
  autoTranslate: false,
  lang: { source: 'ja', target: 'th' },
  translation: {
    mode: 'cloud',
    gemini: {
      apiKey: '',
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
  display: { mode: 'target-plus-source-on-hover', fontScale: 1, boxOpacity: 0.92 },
  performance: { prefetchLookahead: 3, maxConcurrentOcr: 1 },
  perSet: {},
};

const KEY = 'settings';

/** Deep-merge stored values over defaults so a new field never reads undefined. */
function hydrate(stored: unknown): Settings {
  const s = (stored ?? {}) as Partial<Settings>;
  const d = DEFAULT_SETTINGS;
  return {
    ...d,
    ...s,
    version: 1,
    lang: { ...d.lang, ...s.lang },
    translation: {
      ...d.translation,
      ...s.translation,
      gemini: { ...d.translation.gemini, ...s.translation?.gemini },
      ollama: { ...d.translation.ollama, ...s.translation?.ollama },
    },
    ocr: { ...d.ocr, ...s.ocr },
    display: { ...d.display, ...s.display },
    performance: { ...d.performance, ...s.performance, maxConcurrentOcr: 1 },
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
