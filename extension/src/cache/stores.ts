import { type CacheEntry, type CacheLimits, normalizeCacheLimits, planEviction } from '../core/cache-budget';
import { makeLog } from '../shared/log';
import type { CacheStats } from '../shared/messages';
import { loadSettings } from '../shared/settings';
import { approxBytes, db, type OcrRecord, type TranslationRecord } from './db';

/**
 * Read/write helpers over the two stores, plus LRU eviction.
 *
 * Every read touches lastAccessedAt, because the thing worth keeping is what is
 * being re-read — a chapter the user is part way through — not what happened to
 * be written most recently.
 *
 * How much is kept is the reader's choice and lives in settings; what to drop
 * when that is exceeded is arithmetic and lives in core/cache-budget.ts. This
 * file only moves records.
 */

const log = makeLog('cache');

export async function getOcr(key: string): Promise<OcrRecord | undefined> {
  const store = await db();
  const rec = await store.get('ocr', key);
  if (!rec) return undefined;
  rec.lastAccessedAt = Date.now();
  void store.put('ocr', rec);
  return rec;
}

export async function putOcr(rec: Omit<OcrRecord, 'createdAt' | 'lastAccessedAt' | 'bytes'>) {
  const now = Date.now();
  const full: OcrRecord = { ...rec, createdAt: now, lastAccessedAt: now, bytes: 0 };
  full.bytes = approxBytes(full);
  await (await db()).put('ocr', full);
}

export async function getTranslations(keys: readonly string[]): Promise<Map<string, string>> {
  const store = await db();
  const tx = store.transaction('translation', 'readwrite');
  const out = new Map<string, string>();
  const now = Date.now();

  await Promise.all(
    keys.map(async (key) => {
      const rec = await tx.store.get(key);
      if (!rec) return;
      out.set(key, rec.out);
      rec.lastAccessedAt = now;
      void tx.store.put(rec);
    }),
  );
  await tx.done;
  return out;
}

export async function putTranslations(
  records: readonly Omit<TranslationRecord, 'createdAt' | 'lastAccessedAt' | 'bytes'>[],
) {
  if (records.length === 0) return;
  const store = await db();
  const tx = store.transaction('translation', 'readwrite');
  const now = Date.now();

  for (const rec of records) {
    const full: TranslationRecord = { ...rec, createdAt: now, lastAccessedAt: now, bytes: 0 };
    full.bytes = approxBytes(full);
    void tx.store.put(full);
  }
  await tx.done;
}

/**
 * Every record in both stores, reduced to what the budget cares about.
 *
 * One pass, reused for both the stats readout and the eviction plan. The old
 * code scanned everything to add up bytes and then scanned again to evict; the
 * plan needs the same three fields either way, so there is no reason to pay
 * twice on a service worker that is fighting to stay alive.
 */
async function scan(): Promise<{ ocr: CacheEntry[]; translation: CacheEntry[] }> {
  const store = await db();
  const out = { ocr: [] as CacheEntry[], translation: [] as CacheEntry[] };
  for (const name of ['ocr', 'translation'] as const) {
    let cursor = await store.transaction(name).store.openCursor();
    while (cursor) {
      const { key, bytes, lastAccessedAt } = cursor.value;
      out[name].push({ key, bytes, lastAccessedAt });
      cursor = await cursor.continue();
    }
  }
  return out;
}

function totals(scanned: { ocr: CacheEntry[]; translation: CacheEntry[] }): CacheStats {
  let bytes = 0;
  for (const e of scanned.ocr) bytes += e.bytes;
  for (const e of scanned.translation) bytes += e.bytes;
  return {
    ocrRecords: scanned.ocr.length,
    translationRecords: scanned.translation.length,
    bytes,
  };
}

export async function cacheStats(): Promise<CacheStats> {
  return totals(await scan());
}

export async function clearCache(which: 'all' | 'ocr' | 'translation'): Promise<void> {
  const store = await db();
  if (which === 'all' || which === 'ocr') await store.clear('ocr');
  if (which === 'all' || which === 'translation') await store.clear('translation');
}

/**
 * Bring the cache back inside the reader's page budget and the byte ceiling.
 *
 * Returns the number of *readings* dropped, which is the number the caller
 * reports; a translation eviction is rare enough, and alarming enough, to be
 * worth its own log line here instead.
 *
 * `limits` is optional so the pipeline can keep calling this with no arguments.
 * Reading settings costs one storage lookup per finished page, which is nothing
 * next to the request that produced the page — and it means changing the
 * setting takes effect on the very next page rather than whenever the service
 * worker next happens to restart.
 */
export async function evictIfNeeded(limits?: CacheLimits): Promise<number> {
  const budget = limits ?? normalizeCacheLimits((await loadSettings()).cache);
  const scanned = await scan();
  const plan = planEviction(scanned.ocr, scanned.translation, budget);
  if (plan.ocr.length === 0 && plan.translation.length === 0) return 0;

  const store = await db();
  if (plan.ocr.length > 0) {
    const tx = store.transaction('ocr', 'readwrite');
    for (const key of plan.ocr) void tx.store.delete(key);
    await tx.done;
  }
  if (plan.translation.length > 0) {
    // Only reachable once every reading has already gone and the byte ceiling
    // is still exceeded. If this shows up in a log, the ceiling is set below
    // what the translation store alone needs.
    log.warn(`byte ceiling still exceeded with no readings left — dropping ${plan.translation.length} translations`);
    const tx = store.transaction('translation', 'readwrite');
    for (const key of plan.translation) void tx.store.delete(key);
    await tx.done;
  }
  return plan.ocr.length;
}
