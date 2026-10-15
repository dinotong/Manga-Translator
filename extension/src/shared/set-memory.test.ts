import { afterEach, describe, expect, it } from 'vitest';
import { MAX_REREADS_PER_SET, observePage } from '../core/lang-memory';
import { loadSetMemory, SET_MEMORY_KEY, updateSetRecord } from './set-memory';

/**
 * A chrome.storage.local whose reads and writes each yield to the event loop,
 * so concurrent read-modify-writes really do interleave unless something
 * serialises them — which is the property under test.
 */
function stubSlowStorage(): Record<string, unknown> {
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
  return area;
}

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe('updateSetRecord', () => {
  it('eight jobs finishing at once all land, across sets', async () => {
    stubSlowStorage();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        updateSetRecord(i % 2 ? 'a' : 'b', (cur) => ({
          record: { ...cur, langCounts: { ja: (cur?.langCounts?.ja ?? 0) + 1 } },
          result: null,
        })),
      ),
    );
    const all = await loadSetMemory();
    expect(all.a?.langCounts?.ja).toBe(4);
    expect(all.b?.langCounts?.ja).toBe(4);
  });

  it('never lets concurrent pages spend more re-reads than the cap', async () => {
    const area = stubSlowStorage();
    // Every page reads as English while the set believes Japanese.
    area[SET_MEMORY_KEY] = { g: { source: 'ja', langCounts: { ja: 1 } } };
    const rereads = await Promise.all(
      Array.from({ length: 8 }, () =>
        updateSetRecord('g', (cur) => {
          const d = observePage(
            { counts: cur?.langCounts, rereads: cur?.langRereads },
            cur?.source && cur.source !== 'auto' ? cur.source : null,
            'en',
            'ja',
          );
          return {
            record: { ...cur, source: d.working, langCounts: d.counts, langRereads: d.rereads },
            result: d.reread,
          };
        }),
      ),
    );
    expect(rereads.filter(Boolean).length).toBeLessThanOrEqual(MAX_REREADS_PER_SET);
    const g = (await loadSetMemory()).g;
    expect(g?.langCounts?.en).toBe(8);
    expect(g?.langRereads).toBeLessThanOrEqual(MAX_REREADS_PER_SET);
  });

  it('a failed write does not wedge the chain', async () => {
    stubSlowStorage();
    await expect(
      updateSetRecord('x', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await updateSetRecord('x', () => ({ record: { source: 'ja' }, result: null }));
    expect((await loadSetMemory()).x).toEqual({ source: 'ja' });
  });
});
