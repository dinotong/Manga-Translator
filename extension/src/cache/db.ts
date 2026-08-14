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
}

export interface OcrRecord {
  /** `${detectorId}:${recognizerId}:${from}:${imageHash}` — see ocrKey(). */
  key: string;
  imageHash: string;
  from: SourceLang;
  natural: Size;
  blocks: OcrBlockRecord[];
  createdAt: number;
  lastAccessedAt: number;
  bytes: number;
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
