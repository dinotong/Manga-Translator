import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import type { Direction, NormRect, Size } from '../types';
import type { SourceLang, TargetLang } from '../shared/lang';

/**
 * Two stores, never one.
 *
 * Reading a page costs a model download, a GPU pass and an API request;
 * translating a string that was already read costs almost nothing. Merging them
 * under one key means changing the translation provider — or just the target
 * language — throws away the expensive half. Keeping them apart also buys a
 * genuinely useful side effect: a line that recurs across a whole series
 * ("「なに！？」", a character's name) hits the translation cache on every later
 * page, chapter and site, because that key is the hash of the text and has
 * nothing to do with which image it came from.
 *
 * IndexedDB, not chrome.storage.local: storage.local is a settings store with a
 * quota that a few dozen pages of OCR would blow through.
 */

export interface OcrBlockRecord {
  rect: NormRect;
  src: string;
  direction: Direction;
  score: number;
  /**
   * The blocks this one was made of, when a model-proposed merge produced it.
   *
   * One level deep, never nested: a merge is formed from detected blocks, and
   * an accepted merge takes its members out of circulation, so no member can
   * itself be a merge.
   *
   * Absent on everything geometry alone produced, which is almost every block
   * on almost every page.
   *
   * ## Why the parts are kept rather than the merge being recomputed
   *
   * Whether to merge is a setting the reader can turn off, but the merge used
   * to be written into the OCR record and nowhere else — so switching it off
   * changed nothing on any page already read, because `runJob` serves the
   * cached reading. The only escapes were clearing the whole cache or
   * right-clicking every image, and neither is something a reader should have
   * to discover. A reversible choice must not be baked into the most expensive
   * cache layer.
   *
   * Storing the parts is the cheap fix rather than re-reading: the model is
   * asked for one item per crop whatever it proposes, so the individual
   * readings already exist at the moment the merge is written and cost nothing
   * to keep. Turning the setting off then drops the merge and hands back the
   * blocks underneath, with no request to anyone.
   */
  parts?: OcrBlockRecord[];
}

/**
 * 2 = merged blocks carry their `parts`, so a merge can be undone here.
 *
 * A record with no `format` was written by the build where a model-proposed
 * merge was irreversible. There is no way to tell such a record apart from an
 * honest ungrouped one — a merge leaves no trace beyond the union rectangle —
 * so when grouping is off they are not served at all and the page is read
 * again. That happens once per page the reader actually revisits, and the
 * replacement record is format 2 and never re-read again.
 */
export const OCR_RECORD_FORMAT = 2;

export interface OcrRecord {
  /** `${detectorId}:${recognizerId}:${from}:${imageHash}` — see ocrKey(). */
  key: string;
  imageHash: string;
  from: SourceLang;
  natural: Size;
  blocks: OcrBlockRecord[];
  /** See OCR_RECORD_FORMAT. Absent means 1. */
  format?: number;
  createdAt: number;
  lastAccessedAt: number;
  bytes: number;
}

/**
 * The blocks to draw, for a reader whose grouping setting is `grouping`.
 *
 * With grouping on the record is served as written. With it off every merge is
 * dropped and its members come back — which is exactly the state the page would
 * have been in had the setting been off when it was read, because the merge is
 * the only thing the setting changes.
 */
export function blocksFor(
  blocks: readonly OcrBlockRecord[],
  grouping: boolean,
): OcrBlockRecord[] {
  if (grouping) return [...blocks];
  return blocks.flatMap((b) => (b.parts && b.parts.length > 0 ? [...b.parts] : [b]));
}

/**
 * Can this cached reading answer for a reader with this setting?
 *
 * No only in one case: the setting is off and the record predates `parts`, so a
 * merge inside it cannot be undone and cannot be detected either. Everything
 * written since is usable under either setting.
 */
export function servesGrouping(record: Pick<OcrRecord, 'format'>, grouping: boolean): boolean {
  return grouping || (record.format ?? 1) >= OCR_RECORD_FORMAT;
}

export interface TranslationRecord {
  /** `${provider}@${model}:${from}-${to}:${sha1(src)}` — see translationKey(). */
  key: string;
  from: SourceLang;
  to: TargetLang;
  src: string;
  out: string;
  createdAt: number;
  lastAccessedAt: number;
  bytes: number;
}

interface MtSchema extends DBSchema {
  ocr: {
    key: string;
    value: OcrRecord;
    indexes: { lastAccessedAt: number };
  };
  translation: {
    key: string;
    value: TranslationRecord;
    indexes: { lastAccessedAt: number };
  };
}

const DB_NAME = 'manga-translator';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<MtSchema>> | null = null;

export function db(): Promise<IDBPDatabase<MtSchema>> {
  // The service worker is torn down and restarted constantly, so this memo is
  // per-lifetime and deliberately not treated as durable state.
  dbPromise ??= openDB<MtSchema>(DB_NAME, DB_VERSION, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        database
          .createObjectStore('ocr', { keyPath: 'key' })
          .createIndex('lastAccessedAt', 'lastAccessedAt');
        database
          .createObjectStore('translation', { keyPath: 'key' })
          .createIndex('lastAccessedAt', 'lastAccessedAt');
      }
    },
  });
  return dbPromise;
}

export function ocrKey(detectorId: string, recognizerId: string, from: SourceLang, hash: string) {
  return `${detectorId}:${recognizerId}:${from}:${hash}`;
}

export function translationKey(
  provider: string,
  model: string,
  from: SourceLang,
  to: TargetLang,
  srcHash: string,
) {
  return `${provider}@${model}:${from}-${to}:${srcHash}`;
}

/** Rough JSON size. Exact accounting is not worth a second serialisation pass. */
export function approxBytes(value: unknown): number {
  return JSON.stringify(value).length * 2;
}
