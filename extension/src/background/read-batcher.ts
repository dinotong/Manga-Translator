import {
  DEFAULT_CAPS,
  MAX_PAGES_PER_REQUEST,
  planBatch,
  type Routed,
} from '../core/batch';
import { PipelineError } from '../shared/errors';
import { makeLog } from '../shared/log';
import type { KeyRing } from '../translation/KeyRing';
import type { ReadResult } from '../translation/GeminiProvider';

const log = makeLog('batch');

/**
 * Collects crops from several pages and reads them in one Gemini request.
 *
 * ## Why
 *
 * Measured on a real long-strip read: 2.5 requests per minute delivering 2.0
 * translated images per minute, against a free-tier allowance of 15 requests per
 * key per minute. The request budget was never the constraint — the round trip
 * was, at a mean of 18 s. Carrying three pages per request triples the images
 * without spending any more of the per-minute budget, which makes it the only
 * lever here that works *under* the ceiling rather than against it.
 *
 * ## The rule that shapes the whole file
 *
 * **The page the reader can see never waits for a batch to fill.** Collecting
 * work means delaying it, and delay on the visible page is the complaint being
 * fixed, not an acceptable price for fixing it. So a page that is actually on
 * screen is dispatched the moment it arrives — and it takes whatever pages were
 * already waiting along with it, because those cost nothing to add and would
 * otherwise need a request of their own.
 *
 * What may wait is work for pages the reader has not reached. The
 * IntersectionObserver starts a page two screens early, which at a normal
 * reading pace is about twelve seconds of slack, so pausing such a page for a
 * few hundred milliseconds to let its neighbours join it is invisible. That
 * distinction is the difference between batching working and batching never
 * firing at all: measured on a luscious album, where there is no prefetch
 * profile and therefore nothing speculative, every job was dispatched alone and
 * not one request carried more than one page.
 *
 * A right-click goes further still and travels alone: it is the reader saying
 * "this one, now", usually because the last attempt was wrong, and giving it its
 * own request keeps it independent of anything else's failure.
 */

/**
 * How long a page nobody is looking at yet waits for company.
 *
 * Short on purpose, and bounded from both sides by measurement. Detection takes
 * 126-481 ms per page and is serialised, so consecutive pages of a strip reach
 * this queue roughly half a second apart — below about 500 ms nothing would ever
 * meet anything else. Above it, the cost is slack taken out of the twelve
 * seconds a lookahead page has before the reader arrives. Nothing on the
 * reader's screen is ever behind this timer.
 */
export const BATCH_LINGER_MS = 700;

/**
 * Why this page is being read, which decides how patient it may be.
 *
 * - `manual` — a right-click. Goes out alone and immediately.
 * - `foreground` — the image is on the reader's screen. Goes out immediately,
 *   taking any waiting pages with it.
 * - `lookahead` — real work for a page the reader will reach, queued by the
 *   IntersectionObserver two screens early. Nobody is looking at it yet, so it
 *   may wait a moment for company.
 * - `speculative` — a prefetch guess. Same patience as `lookahead`.
 *
 * Splitting `foreground` from `lookahead` is what makes batching happen at all
 * on a site with no prefetch profile. Measured before the split: zero multi-page
 * requests across a four minute read of a luscious album, because every job was
 * nominally "foreground" and every one of them dispatched alone.
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

interface Waiting extends ReadRequest {
  bytes: number;
  resolve: (slots: Slot) => void;
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
export function readPageBatched(req: ReadRequest): Promise<Slot> {
  return new Promise<Slot>((resolve, reject) => {
    const waiting: Waiting = {
      ...req,
      bytes: req.crops.reduce((n, c) => n + c.byteLength, 0),
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
    timers.set(lane, setTimeout(() => flush(lane), BATCH_LINGER_MS));
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

  let routed: Routed;
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

  if (live.length > 1) {
    log.info(`read ${live.length} pages in one request (${pages.reduce((n, p) => n + p.length, 0)} crops)`);
  }

  live.forEach((w, i) => {
    const slots = routed.perPage[i] ?? w.crops.map(() => null);
    const answered = !routed.missed.includes(i);
    if (answered || w.retried || live.length === 1) {
      w.resolve(slots);
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
