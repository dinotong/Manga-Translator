import {
  DEFAULT_CAPS,
  MAX_PAGES_PER_REQUEST,
  planBatch,
  type RoutedGroup,
} from '../core/batch';
import { SPECULATIVE_ARRIVAL_GAP_MS } from '../core/prefetch';
import { PipelineError } from '../shared/errors';
import { makeLog } from '../shared/log';
import type { KeyRing } from '../translation/KeyRing';
import type { PagesRead, ReadResult } from '../translation/GeminiProvider';

const log = makeLog('batch');

/**
 * Collects crops from several pages and reads them in one Gemini request.
 *
 * ## Why
 *
 * Measured on a real long-strip read: 2.5 requests per minute delivering 2.0
 * translated images per minute, against a free-tier allowance of 15 requests per
 * key per minute. The request budget was never the constraint — the round trip
 * was, at a mean of 18 s.
 *
 * ## What batching is and is not worth, stated carefully
 *
 * This file used to claim that three pages per request "triples the images".
 * That was true when work was serialised and one job meant one request. It is
 * not true now and the sentence has misled a reader of these logs already.
 *
 * Concurrency is capped in **pages**, not requests (`speculativeAllowance`,
 * core/scheduling.ts). Pages complete at *pages in flight ÷ round trip*, and
 * repacking the same pages into fewer requests does not change either term. What
 * batching actually buys is **requests per page**, and therefore how high the
 * page ceiling can go before the free tier's per-minute allowance is the thing
 * that binds. Seven pages one-per-request is seven requests; the same seven
 * packed three-up is between two and three, and that difference is what makes a
 * *higher* page ceiling affordable.
 *
 * So batching is not the throughput lever. It is what keeps the throughput lever
 * usable, and it must be working before raising the ceiling is safe.
 *
 * ## The rule that shapes the whole file
 *
 * **The page the reader is reading never waits for a batch to fill.** Collecting
 * work means delaying it, and delay on the page in front of the reader is the
 * complaint being fixed, not an acceptable price for fixing it. So the page
 * being read is dispatched the moment it arrives — and it takes whatever pages
 * were already waiting along with it, because those cost nothing to add and
 * would otherwise need a request of their own.
 *
 * "Being read" is the page nearest the middle of the viewport, decided in the
 * content script (core/foreground.ts). It used to be "overlapping the viewport",
 * which says the same thing on a paged reader and nothing at all on a long
 * strip: a 1,700 px page overlaps a 768 px viewport for several screens either
 * side of being read, so every job was foreground and every one went out alone —
 * measured on e-hentai MPV, 25 pages, 18 requests, zero batched, even at a
 * forced 1.3 s per screen.
 *
 * What may wait is work for pages the reader has not reached, whether or not
 * they are also on screen. The IntersectionObserver starts a page two screens
 * early, which at a normal reading pace is about twelve seconds of slack, so
 * pausing such a page for a few hundred milliseconds to let its neighbours join
 * it is invisible.
 *
 * ## What happens to a page that becomes the one being read while it waits
 *
 * It waits out the timer, and that is the whole exposure: BATCH_LINGER_MS from
 * the moment it was queued, after which its lane flushes whether or not it found
 * company. That is enforced by `remainingLinger` rather than merely stated — a
 * page left behind by the crop cap gets what remains of its own window, not a
 * fresh one, which is how this promise was being broken at more than twice the
 * window before it was measured. It cannot compound — the very next job for the
 * page being read flushes the lane immediately and takes it along — so the worst
 * case is one window against a job whose round trip measures 2.8-50 s. A promotion
 * channel back from the content script would need a message type, a scroll-time
 * recomputation of which page is nearest, and a lane lookup, to save that. If
 * the owner would rather have it, the seam is `flush(lane)`.
 *
 * A right-click goes further still and travels alone: it is the reader saying
 * "this one, now", usually because the last attempt was wrong, and giving it its
 * own request keeps it independent of anything else's failure.
 */

/**
 * How long a page nobody is looking at yet waits for company.
 *
 * ## Why this is derived rather than chosen
 *
 * It was 700 ms, from the right lower bound — detection is serialised at
 * 126-481 ms a page, so below about 500 ms nothing would ever meet anything
 * else. But a lower bound is not a size, and measured on a live read the window
 * expired at a flat `lingered≈705ms` while leaving with **one page**, over and
 * over:
 *
 *     request done: 1 page(s), 1 crops, lingered=713ms wire= 2106ms
 *     request done: 2 page(s), 2 crops, lingered=707ms wire=26298ms
 *     request done: 1 page(s), 2 crops, lingered=705ms wire=49517ms
 *
 * The number that was missing is what sets the *arrival* rate. Speculative pages
 * are spaced by `MIN_PREFETCH_GAP_MS` — politeness towards the reader's image
 * host, and not negotiable — checked on a `PREFETCH_TICK_MS` tick, so they can
 * arrive no closer than 750 ms apart. A 700 ms window is therefore *just* under
 * one arrival gap: it reliably catches nothing, occasionally catches one page on
 * jitter, and can never catch two. Every observation above follows from that.
 *
 * So the window is `MAX_PAGES_PER_REQUEST - 1` arrival gaps, which is the least
 * time in which a full batch can physically assemble. Deriving it means the
 * three constants cannot drift apart again — change the politeness gap or the
 * batch size and this follows.
 *
 * ## What it costs
 *
 * A lookahead page waits up to this long extra. Set against a measured request
 * of 2.8-50 s and the twelve seconds of lead the IntersectionObserver already
 * buys, that is noise. Nothing on the reader's screen is ever behind this timer:
 * `foreground` and `manual` never wait, and a foreground arrival flushes the
 * lane and takes the waiting pages with it.
 */
export const BATCH_LINGER_MS =
  (MAX_PAGES_PER_REQUEST - 1) * SPECULATIVE_ARRIVAL_GAP_MS;

/**
 * Why this page is being read, which decides how patient it may be.
 *
 * - `manual` — a right-click. Goes out alone and immediately.
 * - `foreground` — the page the reader is reading. Goes out immediately, taking
 *   any waiting pages with it.
 * - `lookahead` — real work for a page the reader will reach, queued by the
 *   IntersectionObserver two screens early. Nobody is reading it yet, so it may
 *   wait a moment for company — including when it is on screen, which on a long
 *   strip most of them are.
 * - `speculative` — a page fetched ahead of the reader, either from a URL the
 *   site published or from one derived from the current page's. Same patience as
 *   `lookahead`.
 *
 * Splitting `foreground` from `lookahead` is what makes batching happen at all.
 * Measured before the split: zero multi-page requests across a four minute read
 * of a luscious album, because every job was nominally "foreground" and every
 * one of them dispatched alone.
 */
export type ReadKind = 'manual' | 'foreground' | 'lookahead' | 'speculative';

/** Kinds that may sit in a queue waiting for company. */
function mayWait(kind: ReadKind): boolean {
  return kind === 'lookahead' || kind === 'speculative';
}

export interface ReadRequest {
  /** Groups requests that may legally share one Gemini call. */
  lane: string;
  jobId: string;
  crops: readonly ArrayBuffer[];
  kind: ReadKind;
  /** The ring to send with, if this request is the one that triggers dispatch. */
  ring: KeyRing;
  signal?: AbortSignal;
}

type Slot = (ReadResult | null)[];

/**
 * One page's share of a reply: an answer per crop, plus any merges the model
 * proposed for that page.
 *
 * The groups travel with the slots rather than being applied here because
 * deciding whether to believe them needs the page's *geometry*, which lives with
 * the caller (background/pipeline.ts, via core/merge-proposals.ts). This file
 * only has to make sure a claim reaches the page it was made about.
 */
export interface PageRead {
  slots: Slot;
  groups: RoutedGroup[];
}

interface Waiting extends ReadRequest {
  bytes: number;
  /** When the page joined a lane, so the wait for company can be told apart. */
  queuedAt: number;
  resolve: (read: PageRead) => void;
  reject: (err: unknown) => void;
  /** Already sent once inside a batch that came back useless. */
  retried: boolean;
}

const lanes = new Map<string, Waiting[]>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Read one page's crops, possibly inside a request carrying other pages.
 *
 * Resolves with one slot per crop, in the order the crops were given. A `null`
 * slot means the model said nothing usable about that crop — the caller already
 * knows how to show that as a refused box.
 */
export function readPageBatched(req: ReadRequest): Promise<PageRead> {
  return new Promise<PageRead>((resolve, reject) => {
    const waiting: Waiting = {
      ...req,
      bytes: req.crops.reduce((n, c) => n + c.byteLength, 0),
      queuedAt: Date.now(),
      resolve,
      reject,
      retried: false,
    };

    if (req.kind === 'manual') {
      // Alone, deliberately. See the header.
      void dispatch(req.lane, [waiting]);
      return;
    }

    if (!mayWait(req.kind)) {
      const queue = lanes.get(req.lane) ?? [];
      // The visible page leads; whatever was already waiting rides along, up to
      // the cap. `planBatch` is asked about the tail only, so the visible page
      // can never be the one squeezed out.
      const companions = planBatch(
        queue.map((w) => ({ id: w.jobId, crops: w.crops.length, bytes: w.bytes })),
        { ...DEFAULT_CAPS, maxPages: MAX_PAGES_PER_REQUEST - 1 },
      );
      const take = queue.splice(0, companions.length);
      lanes.set(req.lane, queue);
      if (queue.length === 0) clearLingerTimer(req.lane);
      void dispatch(req.lane, [waiting, ...take]);
      return;
    }

    const queue = lanes.get(req.lane) ?? [];
    queue.push(waiting);
    lanes.set(req.lane, queue);
    if (queue.length >= MAX_PAGES_PER_REQUEST) {
      flush(req.lane);
    } else if (!timers.has(req.lane)) {
      timers.set(
        req.lane,
        setTimeout(() => flush(req.lane), BATCH_LINGER_MS),
      );
    }
  });
}

/**
 * How much of its window a page still has, given when it started waiting.
 *
 * Pure and exported so the invariant at the top of this file — no page waits
 * longer than BATCH_LINGER_MS from the moment it was queued — is a thing that
 * can be checked rather than a thing that is claimed. It was claimed, and
 * measurement found it false at more than twice the window.
 */
export function remainingLinger(oldestQueuedAt: number, now: number): number {
  return Math.max(0, BATCH_LINGER_MS - (now - oldestQueuedAt));
}

function clearLingerTimer(lane: string): void {
  const t = timers.get(lane);
  if (t !== undefined) clearTimeout(t);
  timers.delete(lane);
}

function flush(lane: string): void {
  clearLingerTimer(lane);
  const queue = lanes.get(lane) ?? [];
  if (queue.length === 0) return;
  const planned = planBatch(queue.map((w) => ({ id: w.jobId, crops: w.crops.length, bytes: w.bytes })));
  const take = queue.splice(0, planned.length);
  lanes.set(lane, queue);
  if (queue.length > 0 && !timers.has(lane)) {
    // 🔴 The leftovers get what is *left* of their own window, not a fresh one.
    //
    // This used to re-arm at the full BATCH_LINGER_MS, which quietly broke the
    // promise made at the top of this file — "BATCH_LINGER_MS from the moment it
    // was queued". A page denied a seat by the crop cap started its wait over,
    // and on a dense gallery that is the common case, not a corner: measured at
    // `lingered=3011ms` against a 1500 ms window, twice the documented exposure.
    //
    // Worse, it waited for company it had already been refused. `planBatch` had
    // just decided this page cannot ride with the one in front of it; another
    // window changes nothing about that, it only delays the page.
    const oldest = Math.min(...queue.map((w) => w.queuedAt));
    timers.set(lane, setTimeout(() => flush(lane), remainingLinger(oldest, Date.now())));
  }
  void dispatch(lane, take);
}

async function dispatch(lane: string, batch: Waiting[]): Promise<void> {
  // A page the reader has already left is dropped here rather than sent. This is
  // the last moment cancellation is free; past this point the request is on the
  // wire and stopping it saves nothing, so the reply is kept and cached.
  const live = batch.filter((w) => {
    if (!w.signal?.aborted) return true;
    w.reject(new PipelineError('CANCELLED', 'aborted before the request left'));
    return false;
  });
  if (live.length === 0) return;

  const ring = live[0]!.ring;
  const pages = live.map((w) => w.crops);
  // How long the most patient page in this batch waited for company. Bounded by
  // BATCH_LINGER_MS by construction, but printed rather than assumed: it is one
  // of the four things that could be absorbing the pipeline's parallelism, and
  // the only one this file can answer for.
  const sentAt = Date.now();
  const lingered = Math.max(...live.map((w) => sentAt - w.queuedAt));

  let routed: PagesRead;
  try {
    // No abort signal: one reader turning a page must not cancel a request that
    // is also carrying two other pages, and the reply is cached either way.
    routed = await ring.readPages(pages);
  } catch (err) {
    if (err instanceof PipelineError && err.code === 'PROVIDER_REFUSED' && live.length > 1) {
      // One page poisoned the batch. Splitting is what stops a single refused
      // panel from costing the other two pages their translation entirely; each
      // then gets the existing per-block retry on its own.
      log.warn(`batch of ${live.length} refused — splitting`);
      for (const w of live) void dispatch(lane, [{ ...w, retried: true }]);
      return;
    }
    for (const w of live) w.reject(err);
    return;
  }

  log.info(
    `request done: ${live.length} page(s), ${pages.reduce((n, p) => n + p.length, 0)} crops, ` +
      `lingered=${lingered}ms wire=${Date.now() - sentAt}ms`,
  );

  live.forEach((w, i) => {
    const slots = routed.perPage[i] ?? w.crops.map(() => null);
    const answered = !routed.missed.includes(i);
    if (answered || w.retried || live.length === 1) {
      w.resolve({ slots, groups: routed.groups[i] ?? [] });
      return;
    }
    // The reply covered this page not at all, and it shared the request with
    // others — most likely the model lost track of the ids. One solo retry is
    // cheap next to handing the reader a blank page.
    log.warn(`page ${i + 1} of ${live.length} came back empty — retrying alone`);
    void dispatch(lane, [{ ...w, retried: true }]);
  });
}

/** Test seam and teardown: forget everything queued. */
export function resetBatcher(): void {
  for (const lane of timers.keys()) clearLingerTimer(lane);
  lanes.clear();
}
