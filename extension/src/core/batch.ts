/**
 * Packing crops from several manga pages into one Gemini request, and — the
 * part that actually matters — getting every answer back to the page it came
 * from.
 *
 * Why batch at all: the free tier meters *requests*, 15 per key per minute and
 * 1,000 per key per day. Measured on a real long-strip read, one page per
 * request delivered 2.0 translated images per minute while issuing only 2.5
 * requests per minute — a sixth of one key's allowance. The ceiling was never
 * the thing in the way; the round trip was. Carrying three pages in one request
 * triples the images without touching the request budget at all, which is the
 * only lever here that works *under* the limit rather than against it.
 *
 * Why this file is pure and separately tested: a batched reply is a flat list of
 * items covering several pages, and putting one page's dialogue onto another
 * page is the worst failure this project has — worse than showing nothing,
 * because the reader cannot notice it. Ordering is not trusted. Every crop
 * carries an explicit `p<page>b<block>` id and the reply is routed by that id
 * alone.
 */

import { joinLayoutBreaks } from './reflow';
import type { NormRect } from '../types';

/**
 * Pages per request.
 *
 * Three, from measurement rather than roundness. Single-page requests against
 * `gemini-flash-lite-latest` measured 1.3-41 s with a mean of 18 s, and that
 * spread is server-side variance, not payload size — the 181 KB request came
 * back in 15 s while an 18 KB one took 27 s. So the cost of a request is mostly
 * fixed, and the pages riding along are nearly free. What stops it going higher
 * is the other end of the trade: a batch is atomic to the reader, so the first
 * page in it waits for the slowest, and at four-plus pages a single unlucky
 * 40 s response holds back more of the strip than the batching saved.
 */
export const MAX_PAGES_PER_REQUEST = 3;

/**
 * Crops per request, across all pages in it.
 *
 * Twenty-four leaves room for a dense page without letting one enormous page
 * plus two normal ones become an outlier request.
 *
 * ## Why requests carry two pages and not three, and why that is fine
 *
 * The original note here said "detection returned 0-9 blocks per page on the
 * measured galleries, so three pages is typically 6-15 crops". Measured since on
 * a text-dense gallery, pages run **3-23 crops**, so that sample was of thin
 * pages and the sentence built on it no longer holds. Two dense pages exhaust
 * this cap on their own:
 *
 *     request done: 2 page(s), 23 crops   <- at the cap
 *     request done: 1 page(s), 15 crops   <- a companion would need <= 9
 *     request done: 2 page(s), 22 crops   <- at the cap
 *
 * So on a dense gallery it is *this* that limits a batch to two pages, not the
 * collection window, and the fix for that is not to raise this number. Raising
 * it trades a bigger payload, a longer upload inside an already 2.8-50 s round
 * trip, more chance of the model losing track of which crop belongs to which
 * page, and a wider blast radius when one page poisons a batch — all to save
 * requests, which measurement says are not scarce right now (`backoff=0`, our
 * own pacing about 2 s).
 *
 * Two pages per request already halves the request count, which is the whole
 * benefit batching offers (see the header of background/read-batcher.ts: it buys
 * requests per page, not throughput). Three would be worth revisiting only when
 * the per-minute allowance is what binds, and then the honest change is to raise
 * this deliberately with the payload cost understood, not to discover it as a
 * side effect of a window.
 */
export const MAX_CROPS_PER_REQUEST = 24;

/**
 * Encoded image bytes per request.
 *
 * Gemini accepts about 20 MB of inline data per request, so this is nowhere
 * near the API's limit — it is a latency guard. The measured request bodies were
 * 18-181 KB of base64 for one page, so three pages lands around 550 KB; 3 MB is
 * comfortably above anything normal and still an order of magnitude below the
 * point where the upload itself would start to dominate a 15 s round trip.
 */
export const MAX_BYTES_PER_REQUEST = 3 * 1024 * 1024;

export interface BatchCaps {
  maxPages: number;
  maxCrops: number;
  maxBytes: number;
}

export const DEFAULT_CAPS: BatchCaps = {
  maxPages: MAX_PAGES_PER_REQUEST,
  maxCrops: MAX_CROPS_PER_REQUEST,
  maxBytes: MAX_BYTES_PER_REQUEST,
};

/** One page waiting to be read, as far as packing is concerned. */
export interface BatchablePage {
  /** Unique while in flight. Only used to tell pages apart. */
  id: string;
  /** How many crops this page contributes. */
  crops: number;
  /** Total encoded size of those crops. */
  bytes: number;
}

/**
 * How many of the queued pages go in the next request.
 *
 * A prefix, never a subset: the queue is in the order the reader will need the
 * pages, and skipping one to fit a smaller one behind it would translate page 7
 * before page 5.
 *
 * The first page always goes, whatever it costs. A page whose crops exceed the
 * byte cap on their own is not improved by being deferred forever, and refusing
 * it would leave a page permanently untranslatable — the single-page request it
 * would have had is exactly what happens today.
 */
export function planBatch(
  queued: readonly BatchablePage[],
  caps: BatchCaps = DEFAULT_CAPS,
): BatchablePage[] {
  const out: BatchablePage[] = [];
  let crops = 0;
  let bytes = 0;
  for (const page of queued) {
    if (out.length >= Math.max(1, caps.maxPages)) break;
    if (out.length > 0 && (crops + page.crops > caps.maxCrops || bytes + page.bytes > caps.maxBytes)) {
      break;
    }
    out.push(page);
    crops += page.crops;
    bytes += page.bytes;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Ids                                                                 */
/* ------------------------------------------------------------------ */

/**
 * The id attached to one crop: which page in this request, which block on it.
 *
 * Both parts are needed. Block alone cannot say which page, and page alone
 * cannot put the bubbles back in the right boxes — and the model is free to
 * return items in any order, or to drop one, which is precisely when position
 * stops being a safe substitute.
 */
export function cropId(page: number, block: number): string {
  return `p${page + 1}b${block + 1}`;
}

/**
 * Read an id back, forgiving the ways a model writes the same thing.
 *
 * Case and a separator only — `P1B1`, `p1-b1`, `p1 b1` are unmistakably our
 * scheme wearing a different coat, and rejecting them used to be expensive: an
 * unparseable id is an *unrouteable* answer, and a page of unrouteable answers
 * used to fall through to positional routing, which is the failure this file
 * exists to prevent.
 *
 * Deliberately not forgiven: a bare number. `"1"` could be a block index, a page
 * index or the model counting from zero, and there is no reading of it that is
 * safe to guess.
 */
export function parseCropId(raw: unknown): { page: number; block: number } | null {
  if (typeof raw !== 'string') return null;
  const m = /^p\s*(\d+)\s*[-_ ]?\s*b\s*(\d+)$/i.exec(raw.trim());
  if (!m) return null;
  const page = Number(m[1]) - 1;
  const block = Number(m[2]) - 1;
  if (!Number.isInteger(page) || !Number.isInteger(block) || page < 0 || block < 0) return null;
  return { page, block };
}

/* ------------------------------------------------------------------ */
/* Routing the reply back                                              */
/* ------------------------------------------------------------------ */

export interface ReadItem {
  id?: unknown;
  src?: unknown;
  out?: unknown;
}

export interface Routed {
  /** Per page, per crop. `null` where the model said nothing about that crop. */
  perPage: ({ src: string; out: string } | null)[][];
  /** Pages the reply covered not at all — candidates for a solo retry. */
  missed: number[];
  /**
   * Items that carried an id we could not read. Non-zero means the reply was
   * numbered in some scheme of the model's own, which is worth seeing in a log:
   * the request pins an id to each image and the response schema makes `id`
   * required, so this should be zero on every reply.
   */
  unidentified: number;
  /**
   * The reply was placed by position rather than by id.
   *
   * Reported so it can be logged rather than inferred. It should be vanishingly
   * rare against a provider whose schema requires an id, and if it is ever
   * common the fallback should go, not the logging.
   */
  positional: boolean;
}

/**
 * Put each returned item back on the crop it was read from.
 *
 * By id only, across a multi-page batch. Position is accepted as a fallback in
 * exactly one case: a single-page request whose item count matches its crop
 * count, **and in which not one item offered an id of any kind**. That is the
 * shape every request had before batching existed, it cannot put text on the
 * wrong *page* because there is only one, and dropping the fallback would
 * regress a provider that genuinely does not number its answers. With two or
 * more pages in flight there is no safe positional reading, so an unidentifiable
 * item is discarded rather than guessed at.
 *
 * ## Why "no ids of any kind" and not "no ids we could read"
 *
 * The test used to be whether any id *parsed*, which quietly made the two
 * opposite cases identical: a model that returned no ids at all, and a model
 * that numbered every item in a scheme of its own. The second is the dangerous
 * one. Numbering means the model has an opinion about which answer belongs to
 * which image, and if it also reordered the items — the prompt tells it the
 * crops arrive in reading order, and it may disagree about what that order is —
 * then reading the reply by position mirrors every line on the page.
 *
 * That is the same failure class as merging two speakers: the reader gets fluent
 * dialogue in the wrong mouths and no way to notice. A blank page is a worse
 * *experience* and a far better *failure*, so an unreadable numbering now yields
 * nothing, and the batcher retries the page alone.
 */
export function routeItems(
  cropsPerPage: readonly number[],
  items: readonly ReadItem[],
  ): Routed {
  const perPage = cropsPerPage.map((n) => Array.from({ length: n }, () => null as { src: string; out: string } | null));

  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  let placed = 0;
  /**
   * Did the model try to identify its answers at all?
   *
   * Any non-empty id counts, whether or not we can read it — see the header.
   * A model that numbered its answers has an opinion about which goes where,
   * and position must not be used to overrule it.
   */
  let numbered = false;
  let unidentified = 0;

  for (const item of items) {
    const at = parseCropId(item.id);
    if (typeof item.id === 'string' && item.id.trim() !== '') numbered = true;
    if (!at) {
      if (item.id !== undefined && item.id !== null) unidentified++;
      continue;
    }
    const page = perPage[at.page];
    if (!page || at.block >= page.length) continue; // an id for a page we did not send
    if (page[at.block] !== null) continue; // duplicate id: the first answer wins
    page[at.block] = { src: text(item.src), out: joinLayoutBreaks(text(item.out)) };
    placed++;
  }

  let positional = false;
  if (!numbered && placed === 0 && cropsPerPage.length === 1 && items.length === cropsPerPage[0]) {
    const only = perPage[0]!;
    items.forEach((item, i) => {
      only[i] = { src: text(item.src), out: joinLayoutBreaks(text(item.out)) };
    });
    placed = items.length;
    positional = true;
  }

  const missed: number[] = [];
  perPage.forEach((page, i) => {
    if (page.length > 0 && page.every((slot) => slot === null)) missed.push(i);
  });

  return { perPage, missed, unidentified, positional };
}

/* ------------------------------------------------------------------ */
/* Groups: the model saying several crops are one continuous text        */
/* ------------------------------------------------------------------ */

/** A group exactly as it arrives, before anything is believed about it. */
export interface ReadGroup {
  ids?: unknown;
  src?: unknown;
  out?: unknown;
}

export interface RoutedGroup {
  /** Block indices on one page, ascending. */
  blocks: number[];
  /** The whole continuous text, as the model read it. */
  src: string;
  /** One translation of that whole text. */
  out: string;
}

/**
 * What the request says about groups, in one place so the harness and the
 * extension cannot ask for different things and be compared to each other.
 *
 * Two properties of this wording are load-bearing. It insists that **every image
 * still gets its own item**, so a group that is later vetoed on geometry costs
 * nothing at all — the page falls back to exactly the answer the model would
 * have given before groups existed. And it says out loud that **no groups is the
 * normal answer**, because a model asked to find something will find something.
 */
export const GROUP_INSTRUCTIONS: readonly string[] = [
  'Also return "groups", for one specific case:',
  '  Sometimes one sentence is split across several images — most often a',
  '  handwritten note, an afterword, or a caption written over the artwork,',
  '  whose columns were cut apart before you saw them. When, and only when, the',
  '  text of one image continues mid-sentence into another, add an entry:',
  '    ids - the ids of those images, in reading order',
  '    src - the whole continuous source text, joined',
  '    out - one natural translation of the whole thing',
  '',
  'Rules for groups:',
  '- Most pages have none. An empty list is the normal and expected answer.',
  '- Never group two different speakers.',
  '- Never group a sound effect with dialogue.',
  '- Two complete sentences in two bubbles are not a group, however related.',
  '- Never put images from different pages in one group.',
  '- Still return a normal item for every image, grouped ones included.',
];

/**
 * Sort the model's group claims onto the pages they belong to.
 *
 * The same discipline as `routeItems`, and for a sharper reason: a group is a
 * claim that several crops are one sentence, and a group whose ids straddle two
 * pages is claiming that a sentence continues from one book into another. That
 * cannot be true — the pages in a batch are unrelated by construction, which the
 * prompt says out loud — so such a group is dropped rather than trimmed to the
 * page that happens to hold most of it.
 *
 * Nothing here decides whether a group is *right*. That is core/merge-proposals.
 */
export function routeGroups(
  cropsPerPage: readonly number[],
  groups: readonly ReadGroup[],
): RoutedGroup[][] {
  const out: RoutedGroup[][] = cropsPerPage.map(() => []);

  for (const group of groups) {
    if (!Array.isArray(group.ids)) continue;

    const parsed = group.ids.map(parseCropId);
    if (parsed.length === 0 || parsed.some((p) => p === null)) continue;

    const page = parsed[0]!.page;
    if (parsed.some((p) => p!.page !== page)) continue; // spans pages: not a sentence
    const bucket = out[page];
    if (!bucket) continue;

    const blocks = parsed.map((p) => p!.block);
    // An id for a crop that was never sent means the model was numbering and got
    // it wrong, which disqualifies the whole claim rather than the one id.
    if (blocks.some((b) => b >= (cropsPerPage[page] ?? 0))) continue;

    const unique = [...new Set(blocks)].sort((a, b) => a - b);
    if (unique.length < 2) continue;

    bucket.push({
      blocks: unique,
      src: typeof group.src === 'string' ? group.src : '',
      out: typeof group.out === 'string' ? group.out : '',
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Telling the model where the pages divide                             */
/* ------------------------------------------------------------------ */

/**
 * The line that precedes each page's crops in the request.
 *
 * Without it the prompt is simply false once batched — it claims every image is
 * a bubble "cropped from a single manga page, in reading order" — and the model
 * has no way to know that image 6 belongs to a different scene than image 5. It
 * would carry a pronoun, a speaker or an honorific across a page boundary it
 * should not, and the reader would see a coherent-looking translation that is
 * quietly about the wrong characters.
 */
export function pageHeader(page: number, crops: number, total: number): string {
  const many = crops === 1 ? 'image is a bubble' : `images are bubbles`;
  return `--- PAGE ${page + 1} of ${total}: the next ${crops} ${many} from one manga page, in reading order. Their ids are ${cropId(page, 0)}..${cropId(page, crops - 1)}. Do not carry context across this boundary.`;
}

/** Blocks a page contributes, as the pipeline holds them. */
export interface PageBlocks {
  rect: NormRect;
  cropRef: string;
}
