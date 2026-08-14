import type { CacheStats } from '../shared/messages';
import { approxBytes, db, type OcrRecord, type TranslationRecord } from './db';

/**
 * Read/write helpers over the two stores, plus LRU eviction.
 *
 * Every read touches lastAccessedAt, because the thing worth keeping is what is
 * being re-read — a chapter the user is part way through — not what happened to
 * be written most recently.
 */

const BUDGET_BYTES = 200 * 1024 * 1024;
const EVICT_TO_BYTES = 160 * 1024 * 1024;

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

export async function cacheStats(): Promise<CacheStats> {
  const store = await db();
  let bytes = 0;
  for (const name of ['ocr', 'translation'] as const) {
    let cursor = await store.transaction(name).store.openCursor();
    while (cursor) {
      bytes += cursor.value.bytes;
      cursor = await cursor.continue();
    }
  }
  return {
    ocrRecords: await store.count('ocr'),
    translationRecords: await store.count('translation'),
    bytes,
  };
}

export async function clearCache(which: 'all' | 'ocr' | 'translation'): Promise<void> {
  const store = await db();
  if (which === 'all' || which === 'ocr') await store.clear('ocr');
  if (which === 'all' || which === 'translation') await store.clear('translation');
}

/**
 * Evict oldest-accessed OCR records until we are back under budget.
 *
 * Only the ocr store is evicted: translation records are tiny and are the ones
 * that pay off across a whole series, so dropping them saves almost no space
 * while throwing away the best cache hits we have.
 */
export async function evictIfNeeded(): Promise<number> {
  const { bytes } = await cacheStats();
  if (bytes <= BUDGET_BYTES) return 0;

  const store = await db();
  let remaining = bytes;
  let removed = 0;
  let cursor = await store.transaction('ocr', 'readwrite').store.index('lastAccessedAt').openCursor();

  while (cursor && remaining > EVICT_TO_BYTES) {
    remaining -= cursor.value.bytes;
    removed++;
    await cursor.delete();
    cursor = await cursor.continue();
  }
  return removed;
}
