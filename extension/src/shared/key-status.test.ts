import { afterEach, describe, expect, it } from 'vitest';
import { type KeyStatuses, withExhausted } from '../core/quota';
import { loadKeyStatuses, tidyKeyStatuses, updateKeyStatuses } from './key-status';

/** Reads and writes that yield, so unserialised read-modify-writes interleave. */
function stubSlowStorage(): void {
  const area: Record<string, unknown> = {};
  const tick = () => new Promise((r) => setTimeout(r, 1));
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => {
          await tick();
          return key in area ? { [key]: structuredClone(area[key]) } : {};
        },
        set: async (items: Record<string, unknown>) => {
          await tick();
          Object.assign(area, structuredClone(items));
        },
      },
    },
  };
}

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe('updateKeyStatuses', () => {
  it('keeps every mark when jobs write at once', async () => {
    stubSlowStorage();
    const now = Date.now();
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    await Promise.all(ids.map((id) => updateKeyStatuses((cur) => withExhausted(cur, id, now))));
    const got: KeyStatuses = await loadKeyStatuses();
    expect(Object.keys(got).sort()).toEqual(ids);
  });

  it('a tidy running alongside does not drop a fresh mark', async () => {
    stubSlowStorage();
    const now = Date.now();
    const keys = [{ id: 'a', label: 'a', key: 'k1' }, { id: 'b', label: 'b', key: 'k2' }];
    await Promise.all([
      tidyKeyStatuses(keys, now),
      updateKeyStatuses((cur) => withExhausted(cur, 'a', now)),
      tidyKeyStatuses(keys, now),
      updateKeyStatuses((cur) => withExhausted(cur, 'b', now)),
    ]);
    expect(Object.keys(await loadKeyStatuses()).sort()).toEqual(['a', 'b']);
  });
});
