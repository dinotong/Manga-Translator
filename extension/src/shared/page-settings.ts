import type { Settings } from './settings';

/**
 * The part of Settings a content script is allowed to see.
 *
 * The content script runs in every page the browser opens (`<all_urls>`), so it
 * is the context most likely to be compromised, and it never needs the API
 * keys, the model, Ollama's address or anything else that is not about how and
 * when to draw. The worker builds this view and sends it over; the content
 * script has no storage access at all (the worker restricts
 * chrome.storage.local to trusted contexts on start).
 *
 * Built field by field rather than by deleting from a copy, so a field added to
 * Settings later is *not* exposed until someone adds it here on purpose.
 */
export interface PageSettings {
  enabled: boolean;
  autoSites: string[];
  display: Settings['display'];
  performance: Pick<Settings['performance'], 'prefetchLookahead' | 'maxConcurrentRequests'>;
  cache: Pick<Settings['cache'], 'maxPages'>;
}

export function pageSettingsFrom(s: Settings): PageSettings {
  return {
    enabled: s.enabled,
    autoSites: [...s.autoSites],
    display: {
      mode: s.display.mode,
      fontScale: s.display.fontScale,
      plateOpacity: s.display.plateOpacity,
      panelOpacity: s.display.panelOpacity,
      peekOnHover: s.display.peekOnHover,
    },
    performance: {
      prefetchLookahead: s.performance.prefetchLookahead,
      maxConcurrentRequests: s.performance.maxConcurrentRequests,
    },
    cache: { maxPages: s.cache.maxPages },
  };
}
