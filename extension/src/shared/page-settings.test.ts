import { describe, expect, it } from 'vitest';
import { pageSettingsFrom } from './page-settings';
import { DEFAULT_SETTINGS, hydrate } from './settings';

describe('pageSettingsFrom', () => {
  const secret = 'AIza-SECRET-should-never-reach-a-page';
  const s = hydrate({
    ...DEFAULT_SETTINGS,
    autoSites: ['mangadex.org'],
    translation: {
      ...DEFAULT_SETTINGS.translation,
      gemini: { keys: [{ id: 'a', label: 'main', key: secret }], model: 'm', safetyOff: true },
      ollama: { ...DEFAULT_SETTINGS.translation.ollama, baseUrl: 'http://10.0.0.5:11434' },
    },
  });

  it('carries nothing about translation, keys or providers', () => {
    const view = pageSettingsFrom(s);
    const json = JSON.stringify(view);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('10.0.0.5');
    expect(Object.keys(view).sort()).toEqual(['autoSites', 'cache', 'display', 'enabled', 'performance']);
    expect(Object.keys(view.performance).sort()).toEqual(['maxConcurrentRequests', 'prefetchLookahead']);
    expect(Object.keys(view.cache)).toEqual(['maxPages']);
  });

  it('does not pass through fields smuggled into a nested object', () => {
    const tampered = {
      ...s,
      display: { ...s.display, key: secret },
      cache: { ...s.cache, key: secret },
    } as typeof s;
    expect(JSON.stringify(pageSettingsFrom(tampered))).not.toContain(secret);
  });

  it('keeps what the page actually uses', () => {
    const view = pageSettingsFrom(s);
    expect(view.enabled).toBe(s.enabled);
    expect(view.autoSites).toEqual(['mangadex.org']);
    expect(view.display).toEqual(s.display);
    expect(view.performance.prefetchLookahead).toBe(s.performance.prefetchLookahead);
    expect(view.cache.maxPages).toBe(s.cache.maxPages);
  });
});
