import { serialQueue } from '../core/serial';
import type { LangCode } from '../types';
import type { SourceLang } from './lang';

/**
 * What each reading set (gallery/series) has taught us, stored apart from
 * Settings.
 *
 * This used to be `Settings.perSet`, and that placement was the bug. Every job
 * loaded settings once at the start, and `auto` then rebuilt the *whole* map
 * from that snapshot when the page finished and saved it back. With up to eight
 * jobs in flight, each one overwrote the others' evidence — and other
 * galleries' — and the re-read cap in core/lang-memory.ts was checked against
 * a stale count, so it could be exceeded. On top of that every finished page
 * wrote settings, and every settings write fans out to every open tab and
 * re-runs the model prewarm (see shared/key-status.ts, which exists to avoid
 * exactly that).
 *
 * So: its own chrome.storage.local key, nobody listens for changes to it, and
 * every write is a read-modify-write that touches only one set, serialised
 * inside the worker.
 */
export const SET_MEMORY_KEY = 'setLanguageMemory';

export interface SetRecord {
  source?: SourceLang;
  enabled?: boolean;
  /** Pages of this set that read as each script. */
  langCounts?: Partial<Record<LangCode, number>>;
  /** Re-reads already spent correcting this set's language. */
  langRereads?: number;
}

export type SetMemory = Record<string, SetRecord>;

function isRecordMap(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Anything that is not a plain map of plain objects is treated as empty. */
export function normalizeSetMemory(raw: unknown): SetMemory {
  if (!isRecordMap(raw)) return {};
  const out: SetMemory = {};
  for (const [k, v] of Object.entries(raw)) {
    if (isRecordMap(v)) out[k] = v as SetRecord;
  }
  return out;
}

/**
 * Fold the legacy `Settings.perSet` into the store.
 *
 * What is already in the store wins, per set: anything there was written by
 * the new code, after the legacy record stopped being updated, so it is the
 * newer evidence. Sets that only exist in the legacy record are carried over
 * whole. Pure, for the test that has to get this right the one time it runs.
 */
export function mergeLegacySetMemory(legacy: unknown, current: SetMemory): SetMemory {
  return { ...normalizeSetMemory(legacy), ...current };
}

export async function loadSetMemory(): Promise<SetMemory> {
  const got = await chrome.storage.local.get(SET_MEMORY_KEY);
  return normalizeSetMemory(got[SET_MEMORY_KEY]);
}

export async function loadSetRecord(setKey: string): Promise<SetRecord | undefined> {
  return (await loadSetMemory())[setKey];
}

/**
 * Writes queue here, so two jobs finishing at once cannot read the same state
 * and have the second overwrite the first. Only the worker writes during normal
 * operation; the one-off legacy migration goes through the same chain when it
 * runs there.
 */
const serially = serialQueue();

/**
 * Read-modify-write of one set, against fresh state.
 *
 * `fn` sees the record as it is *now*, not as the job saw it when it started,
 * which is what makes a cap checked inside it a real cap. Its return value is
 * both written back and returned alongside whatever extra the caller wants out.
 */
export function updateSetRecord<T>(
  setKey: string,
  fn: (current: SetRecord | undefined) => { record: SetRecord; result: T },
): Promise<T> {
  return serially(async () => {
    const all = await loadSetMemory();
    const { record, result } = fn(all[setKey]);
    await chrome.storage.local.set({ [SET_MEMORY_KEY]: { ...all, [setKey]: record } });
    return result;
  });
}

/** Merge a legacy `perSet` into the store. A no-op for an empty or missing one. */
export function absorbLegacySetMemory(legacy: unknown): Promise<void> {
  if (Object.keys(normalizeSetMemory(legacy)).length === 0) return Promise.resolve();
  return serially(async () => {
    const next = mergeLegacySetMemory(legacy, await loadSetMemory());
    await chrome.storage.local.set({ [SET_MEMORY_KEY]: next });
  });
}
