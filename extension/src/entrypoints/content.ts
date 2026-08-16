import { defineContentScript } from 'wxt/utils/define-content-script';
import { acquire } from '../content/acquire';
import { Overlay } from '../content/overlay/overlay';
import { elementKey, isLoaded, isPageCandidate, pageShape, scanImages } from '../content/scan';
import { profileFor, type SiteProfile } from '../content/site-profiles';
import { readingNow } from '../core/foreground';
import { classifyPage } from '../core/page-kind';
import {
  effectiveLookahead,
  MAX_CONSECUTIVE_MISSES,
  nextPublished,
  pickPrefetch,
  prefetchAllowed,
  type PrefetchGate,
  type PrefetchRefusal,
  prefetchRefusal,
  readAheadLead,
} from '../core/prefetch';
import { clampInFlight, compareWork, type WorkKind } from '../core/scheduling';
import { MAX_PAGES_PER_REQUEST } from '../core/batch';
import { isAutoOn, siteKey } from '../core/site-scope';
import { toErrorPayload } from '../shared/errors';
import { makeLog } from '../shared/log';
import {
  type ContentToSw,
  type JobSource,
  PORT_NAME,
  type Stage,
  type SwToContent,
  type SwToTab,
} from '../shared/messages';
import { loadSettings, type Settings } from '../shared/settings';

const log = makeLog('content');

/** How often the prefetch scheduler is asked whether anything is allowed yet. */
const PREFETCH_TICK_MS = 250;

/**
 * The page side.
 *
 * Everything here is driven by visibility, loading and mutation — never by
 * scroll events. Both target sites are paged readers: on MangaDex the user
 * clicks through pages and a scroll handler would essentially never fire, and
 * imhentai replaces the image without any scrolling at all. "Auto translate on
 * scroll" is really "auto translate on the image changing".
 *
 * The unit of work is therefore not an element but the pair (element, the src it
 * had when the job started). imhentai runs an entire gallery through one
 * `<img id="gimg">`, so an element alone is not an identity, and a result that
 * arrives after a page turn belongs to a page nobody is looking at.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  async main() {
    if (window.top !== window) return; // ad iframes are never manga pages

    let settings = await loadSettings();
    const profile = profileFor(new URL(location.href));
    /**
     * The site this tab counts as, for the per-site auto-translate switch.
     *
     * Read once. A single-page reader can change the path a hundred times in a
     * session but it cannot change its own hostname without a real navigation,
     * which reloads this script anyway.
     */
    const site = siteKey(location.href);
    log.info(`profile=${profile.id} acquire=${profile.acquire} site=${site ?? '(none)'}`);

    const overlay = new Overlay(settings);

    /**
     * One attempt at one image.
     *
     * Identity is the *source* being read, not the element showing it. imhentai
     * runs a whole gallery through one `<img id="gimg">`, and by the time the
     * reader turns to a page it is often already being fetched speculatively —
     * so "is this work already happening?" can only be answered by what is being
     * fetched. Asking the element instead is what made every page turn start a
     * second identical job and wait for it.
     */
    interface Job {
      id: string;
      /** currentSrc of the page being read, or the guessed URL of a prefetch. */
      key: string;
      /** Elements waiting for this result. Empty means nobody is looking yet. */
      imgs: Set<HTMLImageElement>;
      /** Never claimed by an element: rate-limited, and silent when it fails. */
      speculative: boolean;
      /**
       * The URL was derived from another page's rather than read off this one.
       *
       * Only a guess can be *wrong* about a URL, so only a guess counts towards
       * MAX_CONSECUTIVE_MISSES. A published URL that fails says something about
       * that one page — an expired Hath keystamp, a picture pulled — not about
       * whether the site can be read ahead, and each published page is attempted
       * at most once anyway because it is marked covered before the request.
       */
      guessed: boolean;
      /** Gallery page a speculative job was started for; null for real work. */
      page: number | null;
      /** Last stage reported, so an element that joins late shows the truth. */
      stage: Stage;
    }

    const active = new Map<string, Job>();
    /** The one registry of work in flight, keyed by what is being fetched. */
    const byKey = new Map<string, Job>();
    const byImg = new Map<HTMLImageElement, Job>();
    /** Last src each element was successfully translated at. */
    const done = new WeakMap<HTMLImageElement, string>();
    /**
     * Image URL -> the hash of the bytes that URL served, for results we already
     * hold.
     *
     * This is what makes a prefetched page turn instant instead of merely fast.
     * Without it, arriving at a page that was fetched, detected and translated
     * seconds ago still costs a full round trip — content script to worker,
     * re-download the bytes, re-hash them, two IndexedDB reads — purely to
     * rediscover a hash the worker already told us. Measured at 0.65-2.7 s on
     * imhentai, every turn, with the "กำลังอ่านภาพ…" pill up for all of it,
     * which is the wait the owner reported after prefetch supposedly fixed it.
     *
     * The assumption is that one URL serves the same bytes for as long as this
     * page is open. That is the same assumption the browser's own HTTP cache
     * makes — the element is showing those cached bytes right now — and the map
     * dies with the content script, so it cannot outlive the session that
     * observed it. Only URLs we fetched ourselves are ever in here.
     */
    const hashOfUrl = new Map<string, string>();
    /** Last src we have seen on each element, to tell a real page turn from noise. */
    const lastSrc = new WeakMap<HTMLImageElement, string>();
    /** Asked for while the bytes were still downloading; retried from `load`. */
    const pendingLoad = new Map<HTMLImageElement, boolean>();
    /** Elements the user asked for a second time — those skip the cache. */
    const redo = new Set<HTMLImageElement>();
    const waiters = new Map<string, () => void>();
    /**
     * Waiting work, with the reason it was asked for.
     *
     * The kind is not decoration: `pump` orders by it (core/scheduling.ts), so a
     * right-click cannot end up behind a guess, and the worker is told as well
     * so the same ordering holds on the other side of the port.
     */
    const queue: { img: HTMLImageElement; kind: WorkKind }[] = [];

    let watched = new WeakSet<HTMLImageElement>();
    let observing = false;
    let running = 0;
    let jobCounter = 0;
    let lastContextTarget: HTMLImageElement | null = null;

    /**
     * Is this site switched on at all?
     *
     * Two switches, deliberately different in kind: `enabled` is the global kill
     * switch, and `autoSites` says this particular site was opted in. A site
     * nobody opted in is off, so on the overwhelming majority of pages in the
     * browser this is false and nothing below ever runs.
     */
    const siteOn = (): boolean => settings.enabled && isAutoOn(settings.autoSites, site);

    /**
     * Is the reader *reading*, or *choosing*?
     *
     * A cover on a listing page is a manga image by every measure the per-image
     * scorer has, so the scorer waves it through — and the result was quota
     * spent on cover art and translation boxes painted over the very thumbnails
     * being browsed. The question can only be answered one level up, about the
     * page.
     *
     * Recomputed on demand and remembered only for the current task. The verdict
     * genuinely changes underneath us: this script starts at document_idle when
     * MangaDex has inserted its page elements but decoded none of them, so the
     * only honest first answer is "no", and it has to become "yes" the moment
     * `load` fires. Caching it for any longer than one turn of the event loop is
     * how the gate would silently stop a page that was about to work.
     */
    let readerVerdict: boolean | null = null;
    function onReaderPage(): boolean {
      if (readerVerdict !== null) return readerVerdict;
      // A profile that knows the site is the whole answer, both ways: we are not
      // guessing about imhentai's /gallery/ or MangaDex's /title/.
      const known = profile.isReaderPage?.(new URL(location.href));
      readerVerdict = known ?? classifyPage(pageShape(profile)) === 'reader';
      queueMicrotask(() => {
        readerVerdict = null;
      });
      return readerVerdict;
    }

    /** Is anything allowed to happen here without the reader asking? */
    const auto = (): boolean => siteOn() && onReaderPage();
    const srcOf = (img: HTMLImageElement): string => img.currentSrc || img.src;

    /* ---------------- scheduling ---------------- */

    function enqueue(img: HTMLImageElement, manual = false): void {
      // A manual request is the reader pointing at one image on the page in
      // front of them, so it works on any site — that is the whole point of
      // having a manual trigger. Only the automatic path is scoped.
      if (!settings.enabled) return;
      if (!manual && !auto()) return;

      const src = srcOf(img);
      if (!src) return;

      if (!isLoaded(img)) {
        // The single biggest hole in the first version: at the moment a reader
        // swaps `src`, `complete` is false for the whole of the MutationObserver
        // callback, so enqueueing there did nothing and the new page was simply
        // never translated. Remember the request and let `load` deliver it.
        pendingLoad.set(img, manual || (pendingLoad.get(img) ?? false));
        return;
      }

      const alreadyDone = done.get(img) === src;
      if (!manual && alreadyDone) return;
      // A click always forces, whatever happened last time.
      //
      // This used to force only when the page had already *succeeded*, which got
      // the case backwards: an attempt that failed or was refused never reaches
      // `done`, so the reader clicking again precisely *because* it went wrong
      // took the cheap path and could be handed the same cached failure forever.
      // "Do it again" is the entire meaning of the click, and the reader has no
      // way to know which internal state they are in.
      if (manual) redo.add(img);

      // We have already been told what this exact URL hashes to, and we still
      // hold that result. Nothing downstream can produce a different answer, so
      // draw it now rather than spending a round trip to be told again.
      const known = hashOfUrl.get(src);
      if (!manual && known && overlay.has(known)) {
        const current = byImg.get(img);
        if (current) detach(img, current);
        if (overlay.attach(img, known)) {
          overlay.status(img, '');
          done.set(img, src);
          return;
        }
      }

      const current = byImg.get(img);
      if (current) {
        if (current.key === src && !manual) return;
        // The page turned while this was in flight. Finishing it would spend a
        // request from a 1,000/day budget on a page the reader has left.
        detach(img, current);
      }

      // Someone is already fetching exactly this image — the prefetcher, or
      // another element showing the same page. Joining that job is the whole
      // point of prefetching: the answer is already on its way.
      const running = byKey.get(src);
      if (running && !manual) {
        adopt(running, img);
        return;
      }

      const kind: WorkKind = manual ? 'manual' : 'foreground';
      const already = queue.find((q) => q.img === img);
      if (already) {
        // A click on something already queued promotes it rather than adding a
        // second entry for the same element.
        if (kind === 'manual') already.kind = 'manual';
      } else {
        queue.push({ img, kind });
      }
      pump();
    }

    /** Attach an element to work that is already in flight. */
    function adopt(job: Job, img: HTMLImageElement): void {
      if (job.speculative) {
        // The reader caught up with a guess that had not finished — which is the
        // owner's complaint, one instance at a time. Counting it says how often
        // the lead ran out, without needing them to describe it.
        prefetchStats.adopted++;
        log.debug(`adopted prefetch of page ${job.page} — the reader arrived`);
      }
      // No longer a guess: someone is looking at it. That also frees the single
      // speculative slot for the next page ahead.
      job.speculative = false;
      job.imgs.add(img);
      byImg.set(img, job);
      overlay.status(img, `${stageLabel(job.stage)}…`);
    }

    /**
     * This element is no longer waiting on this job.
     *
     * When it was the last one, the job is work nobody wants — the reader turned
     * away — so it is cancelled rather than left to spend a request (D-024).
     */
    function detach(img: HTMLImageElement, job: Job): void {
      job.imgs.delete(img);
      if (byImg.get(img) === job) byImg.delete(img);
      if (job.imgs.size === 0 && !job.speculative) cancel(job);
    }

    function pump(): void {
      // Several at a time. This used to be `maxConcurrentOcr`, which is 1 — a
      // rule written to protect the detector, which really can only run once at
      // a time, but applied to the whole round trip including the seconds spent
      // waiting on Gemini with the GPU idle. Measured, that wait is 97% of a
      // job. Detection is still serialised, in the worker, where the constraint
      // actually is (D-013).
      const budget = clampInFlight(settings.performance.maxConcurrentRequests);
      if (running >= budget || queue.length === 0) return;

      // Re-sort every time rather than keeping a heap: the list is a handful of
      // images, and both terms — what the reader asked for, and how far it is
      // from the middle of the viewport — change as they scroll.
      const centre = window.innerHeight / 2;
      queue.sort((a, b) =>
        compareWork(
          { kind: a.kind, distance: distance(a.img, centre) },
          { kind: b.kind, distance: distance(b.img, centre) },
        ),
      );

      const next = queue.shift();
      if (!next) return;
      if (!next.img.isConnected || !isLoaded(next.img)) return pump();

      running++;
      void run(next.img, next.kind).finally(() => {
        running--;
        pump();
      });
      // A freed slot may admit more than one waiting page.
      pump();
    }

    async function run(img: HTMLImageElement, kind: WorkKind = 'foreground'): Promise<void> {
      const key = srcOf(img);

      // The prefetcher may have started this page while it sat in the queue.
      // A click never joins somebody else's job: the reader is asking for this
      // to be done again, and adopting an in-flight request would hand them the
      // very answer they just rejected.
      const running = byKey.get(key);
      if (running && kind !== 'manual') {
        adopt(running, img);
        return;
      }

      const job: Job = {
        id: `j${++jobCounter}`,
        key,
        imgs: new Set([img]),
        speculative: false,
        guessed: false,
        page: null,
        stage: 'acquire',
      };
      active.set(job.id, job);
      byKey.set(key, job);
      byImg.set(img, job);
      overlay.status(img, 'กำลังอ่านภาพ…');

      let source: JobSource;
      try {
        const got = await acquire(img, profile);
        source = {
          elementKey: elementKey(img),
          url: got.kind === 'url' ? got.url : job.key,
          natural: got.natural,
          pageUrl: location.href,
          setKey: profile.setKey?.(new URL(location.href)) ?? null,
          distance: distance(img, window.innerHeight / 2),
          ...(isBeingRead(img) ? { reading: true } : {}),
          ...(kind === 'manual' ? { manual: true } : {}),
          ...(redo.has(img) ? { force: true } : {}),
          ...(got.kind === 'bytes' ? { image: got.ref } : {}),
        };
        redo.delete(img);
      } catch (err) {
        const payload = toErrorPayload(err);
        overlay.status(img, payload.hint || payload.message, 'error');
        settle(job);
        return; // must not await a reply that will never come — it would stall the queue
      }

      // Cancelled while the bytes were being read: no reply is coming, and
      // creating a waiter now would deadlock the queue.
      if (!active.has(job.id)) return;

      // Hold the slot until the worker answers, so maxConcurrentOcr means what
      // it says rather than counting only the acquisition.
      const settled = new Promise<void>((resolve) => waiters.set(job.id, resolve));
      send({ t: 'RUN', jobId: job.id, source });
      await settled;
    }

    /**
     * Is this the page the reader is looking at, as opposed to one of several
     * that happen to overlap the viewport?
     *
     * Only this side can answer it: the worker sees one job at a time and has
     * nothing to compare it against. Measured as late as possible — right before
     * the RUN message goes out — because acquiring the bytes takes long enough
     * for the reader to have moved.
     *
     * The comparison set is every page the scanner currently accepts, plus this
     * one, so a manual request for something the scanner would not have picked
     * is still judged against the pages around it. See core/foreground.ts.
     */
    function isBeingRead(img: HTMLImageElement): boolean {
      const centre = window.innerHeight / 2;
      const candidates = scanImages(profile);
      if (!candidates.includes(img)) candidates.push(img);
      const nearest = readingNow(
        candidates.map((el) => ({
          key: elementKey(el),
          distance: distance(el, centre),
          onScreen: inViewport(el),
        })),
      );
      return nearest !== null && nearest === elementKey(img);
    }

    /** Forget a job and release whatever is waiting on it. */
    function settle(job: Job): void {
      active.delete(job.id);
      if (byKey.get(job.key)?.id === job.id) byKey.delete(job.key);
      for (const img of job.imgs) {
        if (byImg.get(img)?.id === job.id) byImg.delete(img);
      }
      job.imgs.clear();
      waiters.get(job.id)?.();
      waiters.delete(job.id);
    }

    function cancel(job: Job): void {
      send({ t: 'CANCEL', jobId: job.id });
      settle(job);
    }

    /* ---------------- prefetch (see core/prefetch.ts for the rules) ---------------- */

    /** Pages already fetched, in flight, or attempted. Absolute gallery numbers. */
    const prefetchCovered = new Set<number>();
    let prefetchLastStart = 0;
    /** Guesses in a row that came back as "no such image" — see MAX_CONSECUTIVE_MISSES. */
    let prefetchMisses = 0;
    /** Gallery the two counters above belong to. */
    let prefetchSet: string | null = null;

    /**
     * What prefetch is actually doing, counted rather than guessed at.
     *
     * The reader's report is always the same sentence — "it is only a few pages
     * ahead" — and it has seven possible causes with opposite fixes. Twice now
     * that has been answered by reading the gate and reasoning, and twice the
     * reasoning was wrong, so the tick counts instead. The tick runs four times a
     * second; a tally costs nothing and settles it from one real read.
     *
     * Three things this deliberately does that the first version did not, each
     * because the first version could not have answered the question it was
     * built for:
     *
     *   - **The counts are cumulative over the gallery.** They used to be
     *     cleared on every tick that was *allowed*, so what got printed was
     *     "refusals since the last successful start" — a number that says
     *     nothing about which clause dominates a read, and that is smallest
     *     exactly when prefetch is working. Which clause binds is a question
     *     about the whole read.
     *
     *   - **It logs whether or not the last tick refused.** A refusal-only log
     *     is silent in the one case that matters most: prefetch permitted,
     *     running steadily, and still losing ground to the reader. That is the
     *     throughput story, and the old instrumentation would have shown a
     *     nearly empty console while it happened.
     *
     *   - **It reports the lead** (core/prefetch.ts), which is the reader's
     *     complaint as a number. Everything else here describes an input to the
     *     decision; only this describes what the reader gets.
     *
     * All of it at `info`. `log.debug` is `console.debug`, which DevTools files
     * under Verbose and hides by default, so the existing per-page prefetch
     * lines are invisible unless someone knows to go and turn them on — not a
     * reasonable thing to depend on when the browser time is the scarce
     * resource.
     */
    const prefetchRefusals = new Map<PrefetchRefusal, number>();
    /** Failures by error code. A wrong URL and a refused CDN are not the same problem. */
    const prefetchFailures = new Map<string, number>();
    /** Pages whose translation we already hold, for `readAheadLead`. */
    const prefetchReady = new Set<number>();
    const prefetchStats = { ticks: 0, allowed: 0, started: 0, adopted: 0 };
    const HEARTBEAT_MS = 15_000;

    /**
     * 🔴 The heartbeat runs on its own timer, and that is the whole point.
     *
     * The first version of this called the heartbeat from inside `prefetchTick`.
     * Measured on a real imhentai read it printed **nothing at all** in ninety
     * seconds — one `prefetch page 2` at t=0 and then silence, with jobs j1
     * through j13 proving the content script was alive throughout.
     *
     * The instrument was wired to the thing it was measuring. `prefetchTick`
     * runs on `prefetchTimer`, which `stopPrefetch` clears from four different
     * places, so anything that stopped the tick also stopped the reporting on
     * it — and silence then means either "healthy and quiet" or "the feature is
     * dead", with no way to tell which. That ambiguity is what the read ran into,
     * and it is the same shape as the harness in D-038 that was not calibrated
     * to the thing it was measuring.
     *
     * So: an independent interval, and `ticks` is printed so a tick that has
     * stopped advancing between two heartbeats is visible as a fact rather than
     * as an absence. Silence now has exactly one meaning — the content script
     * itself is gone.
     *
     * `heartbeatAt` is gone with it. Keeping the cadence in a timestamp meant
     * the window was consumed *before* the visible/enabled gates were checked,
     * so a moment spent hidden threw away a whole reporting window.
     */
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let ticksAtLastHeartbeat = 0;

    function startHeartbeat(): void {
      if (heartbeatTimer !== undefined || !profile.prefetch) return;
      heartbeatTimer = setInterval(prefetchHeartbeat, HEARTBEAT_MS);
    }
    function stopHeartbeat(): void {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }

    function prefetchHeartbeat(): void {
      // A backgrounded tab is not reading and must not fill the console.
      if (document.visibilityState !== 'visible') return;
      const gate = prefetchGate();
      const currentPage = profile.pageNumber?.(new URL(location.href)) ?? null;
      const refused =
        [...prefetchRefusals]
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${k}=${n}`)
          .join(' ') || 'none';
      const failed = [...prefetchFailures].map(([k, n]) => `${k}=${n}`).join(' ') || 'none';
      const budget = clampInFlight(settings.performance.maxConcurrentRequests);
      // The tick's own health, in the same line as the numbers it produces —
      // every count below is meaningless if it stopped advancing.
      const moved = prefetchStats.ticks - ticksAtLastHeartbeat;
      ticksAtLastHeartbeat = prefetchStats.ticks;
      const tick =
        prefetchTimer === undefined ? 'STOPPED' : moved === 0 ? 'STALLED' : `+${moved}`;
      log.info(
        `prefetch · lead=${readAheadLead(currentPage, prefetchReady)} at page ${currentPage ?? '?'}` +
          ` · tick=${tick} auto=${gate.enabled}` +
          ` · started=${prefetchStats.started} ready=${prefetchReady.size}` +
          ` adopted=${prefetchStats.adopted} failed{${failed}}` +
          ` misses=${prefetchMisses}/${MAX_CONSECUTIVE_MISSES}` +
          ` · allowed=${prefetchStats.allowed}/${prefetchStats.ticks} refused{${refused}}` +
          ` · lookahead=${gate.lookahead} speculative=${gate.inFlight}/${gate.batchSize ?? 1}` +
          ` jobs=${running}/${budget} queued=${queue.length}`,
      );
    }

    function speculativeInFlight(): number {
      let n = 0;
      for (const job of active.values()) if (job.speculative) n++;
      return n;
    }

    /** One page worth fetching ahead, and where its URL came from. */
    interface PrefetchTarget {
      page: number;
      url: string;
      guessed: boolean;
    }

    /**
     * A page the site itself has already named.
     *
     * Preferred over a derived URL wherever a profile offers both, because there
     * is nothing about it to be wrong. No site does offer both today; the order
     * is here so that when one does, the guess is the fallback and not the
     * default.
     */
    function fromPublished(cfg: SiteProfile['prefetch'], gate: PrefetchGate): PrefetchTarget | null {
      if (!cfg?.published) return null;
      const next = nextPublished({
        pages: cfg.published(document),
        viewportHeight: window.innerHeight,
        lookahead: gate.lookahead,
        covered: prefetchCovered,
      });
      return next ? { page: next.page, url: next.url, guessed: false } : null;
    }

    /** A page whose URL follows from the one on screen. See core/page-url.ts. */
    function fromPattern(
      cfg: SiteProfile['prefetch'],
      url: URL,
      gate: PrefetchGate,
    ): PrefetchTarget | null {
      if (!cfg?.imageUrl) return null;
      const page = profile.pageNumber?.(url) ?? null;
      const pick = pickPrefetch({
        ...gate,
        currentPage: page,
        totalPages: cfg.total?.(document) ?? null,
        covered: prefetchCovered,
      });
      if (pick === null || page === null) return null;

      const shown = scanImages(profile).find(isLoaded);
      const guess = shown ? (cfg.imageUrl(srcOf(shown), pick - page) ?? null) : null;
      return guess ? { page: pick, url: guess, guessed: true } : null;
    }

    /**
     * Everything the gate decides on, read fresh.
     *
     * One function rather than one object built inside the tick, so the
     * heartbeat reports the state the tick would actually see. Two readings
     * assembled separately would eventually disagree, and a diagnostic that
     * disagrees with the thing it describes is worse than none.
     */
    function prefetchGate(): PrefetchGate {
      return {
        now: Date.now(),
        enabled: auto(),
        // Capped by what the cache will actually keep: reading further ahead
        // than that evicts the earliest pages before the reader reaches them,
        // spending the request and the quota for nothing.
        lookahead: effectiveLookahead(
          settings.performance.prefetchLookahead,
          settings.cache.maxPages,
        ),
        visible: document.visibilityState === 'visible',
        foregroundWaiting: queue.length > 0,
        inFlight: speculativeInFlight(),
        // Several pages may be *prepared* at once so their crops leave in one
        // Gemini request. Not a second rate knob — the gap between starts and
        // the "nothing while hidden" rule are untouched, and the number of
        // outbound requests goes down rather than up. See core/batch.ts.
        batchSize: MAX_PAGES_PER_REQUEST,
        consecutiveMisses: prefetchMisses,
        lastStartAt: prefetchLastStart,
      };
    }

    function prefetchTick(): void {
      const cfg = profile.prefetch;
      if (!cfg) return;

      const url = new URL(location.href);
      const setKey = profile.setKey?.(url) ?? null;
      if (setKey !== prefetchSet) {
        // Another gallery: its own numbering, its own file extensions, and its
        // own chance of the URL pattern holding.
        prefetchSet = setKey;
        prefetchCovered.clear();
        prefetchMisses = 0;
        // The counters describe one gallery's read. Carrying them across would
        // mix two books' numbering into one lead figure and one refusal tally.
        prefetchReady.clear();
        prefetchRefusals.clear();
        prefetchFailures.clear();
        prefetchStats.ticks = 0;
        prefetchStats.allowed = 0;
        prefetchStats.started = 0;
        prefetchStats.adopted = 0;
      }

      prefetchStats.ticks++;
      const gate = prefetchGate();
      const refusal = prefetchRefusal(gate);
      if (refusal) prefetchRefusals.set(refusal, (prefetchRefusals.get(refusal) ?? 0) + 1);
      else prefetchStats.allowed++;
      if (refusal) return;

      const target = fromPublished(cfg, gate) ?? fromPattern(cfg, url, gate);
      if (!target) return;

      if (byKey.has(target.url)) {
        // The reader is already on it, or another element asked for it first.
        prefetchCovered.add(target.page);
        return;
      }

      // Marked covered before the request, so a failure is not retried in a loop.
      prefetchCovered.add(target.page);
      prefetchLastStart = Date.now();

      const job: Job = {
        id: `p${++jobCounter}`,
        key: target.url,
        imgs: new Set(),
        speculative: true,
        guessed: target.guessed,
        page: target.page,
        stage: 'acquire',
      };
      active.set(job.id, job);
      byKey.set(target.url, job);
      prefetchStats.started++;
      log.debug(`prefetch page ${target.page} (${target.guessed ? 'guessed' : 'published'})`);
      send({
        t: 'RUN',
        jobId: job.id,
        source: {
          elementKey: `prefetch-${target.page}`,
          url: target.url,
          natural: { w: 0, h: 0 },
          pageUrl: location.href,
          setKey,
          prefetch: true,
        },
      });
    }

    /**
     * The scheduler only ticks on a site that is switched on.
     *
     * `pickPrefetch` would refuse anyway, but a four-times-a-second timer on
     * every tab in the browser is exactly the kind of cost the per-site switch
     * exists to avoid, and "off" should mean the timer does not exist.
     */
    let prefetchTimer: ReturnType<typeof setInterval> | undefined;
    function startPrefetch(): void {
      if (prefetchTimer !== undefined || !profile.prefetch || !auto()) return;
      prefetchTimer = setInterval(prefetchTick, PREFETCH_TICK_MS);
    }
    function stopPrefetch(): void {
      clearInterval(prefetchTimer);
      prefetchTimer = undefined;
    }

    document.addEventListener('visibilitychange', () => {
      // "Stop when the tab is hidden" has to mean the request already running,
      // not just the next one. A backgrounded tab that keeps pulling pages is
      // indistinguishable from a crawler. Work an element is waiting for stays:
      // the reader asked for that one and will see it when they come back.
      if (document.visibilityState === 'visible') return;
      for (const job of Array.from(active.values())) if (job.speculative) cancel(job);
    });

    /* ---------------- port ---------------- */

    /**
     * Connected on demand, not at startup.
     *
     * The content script runs on every page in the browser, and an open port
     * keeps the service worker alive — so connecting eagerly would pin the
     * worker awake for the sake of tabs that will never translate anything. A
     * long-lived port is still the right shape once work starts: it carries
     * progress, it can be cancelled, and it stops Chrome from recycling the
     * worker halfway through a job.
     */
    let livePort: chrome.runtime.Port | null = null;

    function connect(): chrome.runtime.Port {
      const p = chrome.runtime.connect({ name: PORT_NAME });
      p.onMessage.addListener(onPortMessage);
      p.onDisconnect.addListener(() => {
        livePort = null;
        log.debug('port closed');
        abandonInFlight();
      });
      livePort = p;
      return p;
    }

    function send(msg: ContentToSw): void {
      try {
        (livePort ?? connect()).postMessage(msg);
      } catch {
        connect().postMessage(msg);
      }
    }

    /**
     * The worker went away mid-job. Let go of everything that was waiting on it.
     *
     * Without this the page stops translating **for good**, silently. `run`
     * holds its concurrency slot on a promise that only `settle` resolves, and
     * `settle` is only ever reached from a reply on this port — so a worker that
     * is torn down with a job in flight leaves that promise pending forever,
     * `running` permanently above zero, and `pump` returning at its first line
     * on every subsequent call. Chrome restarts MV3 workers constantly, which
     * makes this an ordinary event rather than an edge case, and the symptom is
     * exactly the one reported: translation quietly stops keeping up.
     *
     * Jobs an element is still waiting for are re-queued rather than dropped —
     * the reader is looking at those pages, and the worker will be back the
     * moment we speak to it again. Guesses are not: nobody is waiting, and the
     * prefetcher will make them again if they still make sense.
     */
    function abandonInFlight(): void {
      const stranded = Array.from(active.values());
      if (stranded.length === 0) return;
      log.warn(`worker went away with ${stranded.length} job(s) in flight — releasing them`);
      const retry: HTMLImageElement[] = [];
      for (const job of stranded) {
        for (const img of job.imgs) if (srcOf(img) === job.key) retry.push(img);
        settle(job);
      }
      for (const img of retry) enqueue(img);
    }

    function onPortMessage(msg: SwToContent): void {
      // Unknown id = a job we cancelled. The reply is about a page the reader
      // has already left, and acting on it is exactly the bug this design is
      // built to prevent.
      const job = active.get(msg.jobId);
      if (!job) return;

      if (msg.t === 'PROGRESS') {
        job.stage = msg.stage;
        const text = `${stageLabel(msg.stage)}${msg.detail ? ` · ${msg.detail}` : ''}`;
        for (const img of job.imgs) overlay.status(img, text);
        return;
      }

      if (msg.t === 'RESULT') {
        // Keyed by image hash, so it is worth keeping whatever page it came from
        // — including a prefetch, whose entire purpose is to be waiting here.
        overlay.setResult(msg.hash, msg.natural, msg.blocks);
        // job.key is the URL those bytes came from: the guessed one for a
        // prefetch, the element's own src otherwise. Remembering the pairing is
        // what lets the next turn onto this page skip the round trip entirely.
        hashOfUrl.set(job.key, msg.hash);
        // The guessed URL was a real image, so the pattern holds for this book.
        if (job.speculative && job.guessed) prefetchMisses = 0;
        // Every page this job was started for is now one the reader can turn to
        // without waiting — including one they have already caught up with,
        // which `job.speculative` no longer reports because `adopt` cleared it.
        if (job.page !== null) prefetchReady.add(job.page);

        const stale: HTMLImageElement[] = [];
        for (const img of job.imgs) {
          if (srcOf(img) !== job.key) {
            // The page turned while this was in flight. Drawing it now would put
            // the previous page's dialogue on the page in front of the reader,
            // which is worse than no translation because it cannot be noticed.
            log.debug('result arrived for a src that is no longer on screen — dropped');
            stale.push(img);
            continue;
          }
          overlay.attach(img, msg.hash);
          overlay.status(
            img,
            msg.warning ?? (msg.fromCache ? '' : `แปลแล้ว ${msg.blocks.length} กล่อง`),
            msg.warning ? 'error' : 'info',
          );
          if (!msg.warning) setTimeout(() => overlay.status(img, ''), 1600);
          done.set(img, job.key);
        }
        settle(job);
        for (const img of stale) enqueue(img); // catch up with whatever is showing
        return;
      }

      // Counted for anything the prefetcher started, whether or not the reader
      // has since arrived on it. The code matters: a URL the pattern got wrong
      // and a CDN that refused a burst both surface as a failed guess and both
      // end the gallery's prefetching after two, but only one of them is a bug
      // in the guessing.
      if (job.page !== null) {
        prefetchFailures.set(msg.code, (prefetchFailures.get(msg.code) ?? 0) + 1);
      }

      if (job.imgs.size > 0) {
        for (const img of job.imgs) overlay.status(img, msg.hint || msg.message, 'error');
      } else {
        // A prefetch that failed is not the reader's problem: they never asked
        // for that page and may never reach it. But a *guessed* URL that does
        // not exist says the pattern is wrong for this gallery, and guessing on
        // is just noise at someone else's server — so two in a row stop it.
        //
        // A URL the site published is different in kind. It was not our idea, it
        // failed for a reason belonging to that one page, and the next page's
        // URL is read separately rather than derived from this one — so it
        // proves nothing about the pages after it. Each is tried at most once
        // (marked covered before the request), so the waste is bounded without
        // needing to switch the feature off for the rest of the gallery.
        log.debug(`prefetch failed: ${msg.code} ${msg.message}`);
        if (msg.code === 'ACQUIRE_FAILED' && job.guessed) {
          prefetchMisses++;
          if (prefetchMisses >= MAX_CONSECUTIVE_MISSES) {
            log.info(`prefetch off for this gallery after ${prefetchMisses} bad guesses`);
          }
        }
      }

      settle(job);
    }

    /* ---------------- observers ---------------- */

    // Two screens in both directions.
    //
    // It used to be two above and one below, which is the wrong way round for
    // the case it was written for. Reading a long strip means scrolling *down*,
    // so the pages about to be needed are the ones below the viewport, and the
    // bottom margin is the entire lead time. One screen of lead is less than the
    // height of a single page on both measured galleries (1434 px and 1808 px
    // against a 768 px viewport), so work started only once the page was
    // effectively already arriving — and a page that is already arriving has to
    // be sent on its own, which is why batching never fired here.
    //
    // Two screens is about twelve seconds at a normal reading pace, which is the
    // slack the batcher spends a few hundred milliseconds of.
    const ROOT_MARGIN = { above: 2, below: 2 };
    const io = new IntersectionObserver(
      (entries) => {
        // Asked once for the batch: the page-kind half of `auto()` measures every
        // candidate on the page, and a listing can deliver dozens of entries at
        // a time.
        const on = auto();
        if (!on) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          enqueue(entry.target as HTMLImageElement);
        }
      },
      { rootMargin: `${ROOT_MARGIN.above * 100}% 0px ${ROOT_MARGIN.below * 100}% 0px`, threshold: 0.01 },
    );

    /**
     * Start watching an element, loaded or not.
     *
     * The `load` listener is the important half. It is the only event that says
     * "the bytes on screen are now these", which covers both an element that had
     * not finished downloading during the first scan (MangaDex, every time) and
     * an element whose src was swapped for the next page (imhentai, every turn).
     */
    function watch(img: HTMLImageElement): void {
      if (watched.has(img)) return;
      watched.add(img);
      lastSrc.set(img, srcOf(img));
      if (observing) io.observe(img);
      img.addEventListener('load', onLoad);
    }

    function onLoad(ev: Event): void {
      const img = ev.currentTarget as HTMLImageElement;
      lastSrc.set(img, srcOf(img));
      const asked = pendingLoad.get(img);
      pendingLoad.delete(img);
      if (asked !== undefined) {
        enqueue(img, asked);
        return;
      }
      if (auto() && isPageCandidate(img, profile)) enqueue(img);
    }

    function rescan(): void {
      const on = auto();
      for (const img of scanImages(profile, { includeUnloaded: true })) {
        watch(img);
        if (!on || !isLoaded(img) || !isPageCandidate(img, profile)) continue;
        const r = img.getBoundingClientRect();
        // A preloaded page sitting at 0x0 never intersects, but it is exactly
        // the page the user is about to open — so translate it now and the page
        // turn is a cache hit.
        if (r.width === 0 || nearViewport(r)) enqueue(img);
      }
    }

    let rescanTimer: ReturnType<typeof setTimeout> | undefined;
    function debounceRescan(): void {
      clearTimeout(rescanTimer);
      rescanTimer = setTimeout(rescan, 150);
    }

    const mo = new MutationObserver((records) => {
      let structural = false;
      const on = auto();
      for (const r of records) {
        if (r.type === 'attributes') {
          const img = r.target;
          if (!(img instanceof HTMLImageElement)) continue;
          if (!watched.has(img) && !isPageCandidate(img, profile)) continue;

          // `src` reflects the new value immediately; `currentSrc` does not
          // update until the resource is selected, so this is the earliest
          // moment a page turn can be detected.
          const next = img.src || img.currentSrc;
          if (lastSrc.get(img) === next) continue; // rewritten to the same URL
          lastSrc.set(img, next);

          // Drop the old translation now, not when the new one arrives —
          // between those two moments it would be sitting on a different page.
          overlay.invalidate(img);
          overlay.status(img, '');
          done.delete(img);
          const job = byImg.get(img);
          // Only the element moved on. If the job is one the prefetcher started
          // and another element still wants it, detach() leaves it running.
          if (job) detach(img, job);

          watch(img);
          if (on) enqueue(img); // parked until `load`, then run
        } else if (r.type === 'childList' && r.addedNodes.length > 0) {
          structural = true;
        }
      }
      if (structural) debounceRescan();
    });

    function startObserving(): void {
      if (observing) return;
      observing = true;
      startPrefetch();
      // Deliberately not inside `startPrefetch`: the case worth reporting most
      // is the one where the tick is *not* running.
      startHeartbeat();
      mo.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'srcset', 'data-src', 'data-original'],
      });
      rescan();
    }

    /**
     * Turning the extension off must actually stop it.
     *
     * Not "keep observing and check a flag": the reader turned it off, so the
     * observers come down, the queue empties, work in flight is cancelled and
     * every overlay goes away.
     */
    function stopObserving(): void {
      observing = false;
      io.disconnect();
      mo.disconnect();
      stopPrefetch();
      stopHeartbeat();
      clearTimeout(rescanTimer);
      for (const job of Array.from(active.values())) cancel(job);
      queue.length = 0;
      pendingLoad.clear();
      redo.clear();
      hashOfUrl.clear();
      prefetchCovered.clear();
      prefetchMisses = 0;
      // Fresh set so re-enabling re-observes everything currently on the page;
      // the load listeners survive, and adding them again is a no-op.
      watched = new WeakSet<HTMLImageElement>();
      overlay.clearAll();
    }

    // A paged reader may change the URL without touching the DOM, and history
    // methods fire no event of their own.
    for (const name of ['pushState', 'replaceState'] as const) {
      const original = history[name];
      history[name] = function patched(this: History, ...args: Parameters<History['pushState']>) {
        const out = original.apply(this, args);
        dispatchEvent(new Event('mt:navigate'));
        return out;
      };
    }
    for (const evt of ['popstate', 'mt:navigate']) {
      addEventListener(evt, () => {
        revalidate();
        // MangaDex goes from a title page to a chapter without ever reloading
        // this script, so the reader/listing answer changes here and nowhere
        // else. The prefetch timer follows it: guessing at the next page number
        // while the reader is browsing covers is a request nobody asked for.
        if (auto()) startPrefetch();
        else stopPrefetch();
        debounceRescan();
      });
    }

    /**
     * Check the one invariant that matters: every drawn translation belongs to
     * the bytes currently in the element under it.
     *
     * Clearing everything on a URL change instead — which is what this used to
     * do — is wrong on MangaDex, where a page turn shows a *different* element
     * that already has a correct, already-paid-for translation on it. Wiping it
     * meant the reader saw their translation vanish on every turn and, because
     * the element was already marked done, it never came back.
     */
    function revalidate(): void {
      for (const img of overlay.mountedTargets()) {
        if (!img.isConnected || done.get(img) !== srcOf(img)) overlay.invalidate(img);
      }
    }

    document.addEventListener(
      'contextmenu',
      (e) => {
        const t = e.target;
        lastContextTarget = t instanceof HTMLImageElement ? t : null;
      },
      true,
    );

    chrome.runtime.onMessage.addListener((raw: unknown) => {
      const msg = raw as SwToTab;
      if (msg?.t === 'CONTEXT_TRANSLATE') {
        const img = lastContextTarget ?? findBySrc(msg.srcUrl);
        if (img) {
          // Explicit user action beats every cache and toggle — that is the
          // whole point of having a manual trigger while debugging.
          watch(img);
          enqueue(img, true);
        } else {
          log.warn('right-clicked image not found in this document');
        }
      } else if (msg?.t === 'TRANSLATE_VISIBLE') {
        for (const img of scanImages(profile)) {
          if (inViewport(img)) {
            watch(img);
            enqueue(img, true);
          }
        }
      } else if (msg?.t === 'SETTINGS_CHANGED') {
        void loadSettings().then((next) => {
          const wasOn = siteOn();
          settings = next;
          // Either switch going off stops everything here, including the
          // overlays already drawn: the reader just said "not on this site",
          // and leaving the last page's translation up is not what that means.
          //
          // Keyed on the *switch*, not on `auto()`. Being on a listing page is
          // not the reader turning anything off — the observers stay up so that
          // clicking through to a chapter starts working without a reload.
          if (!siteOn()) {
            stopObserving();
            return;
          }
          overlay.updateSettings(next);
          if (!wasOn) startObserving();
          else rescan();
        });
      }
      return false;
    });

    function findBySrc(srcUrl: string | undefined): HTMLImageElement | null {
      if (!srcUrl) return null;
      return (
        Array.from(document.images).find((i) => i.currentSrc === srcUrl || i.src === srcUrl) ?? null
      );
    }

    /**
     * Stop while the document is away, and come back when it does.
     *
     * `pagehide` fires both when a document is torn down and when it is frozen
     * into the back/forward cache, and this used to be `{ once: true }` with no
     * counterpart. So a reader who pressed Back — on a paged reader, an ordinary
     * thing to do — came back to a restored document whose prefetch timer had
     * been cleared and which nothing would ever restart. The feature was off for
     * the rest of that page's life, silently.
     *
     * `pageshow` with `persisted` is exactly the restore case, and the guards
     * inside `startPrefetch` mean a document that was genuinely torn down never
     * gets here at all.
     */
    addEventListener('pagehide', () => {
      stopPrefetch();
      stopHeartbeat();
    });
    addEventListener('pageshow', (e) => {
      if (!(e as PageTransitionEvent).persisted || !observing) return;
      startPrefetch();
      startHeartbeat();
    });

    // Nothing is observed, scanned or timed on a site the reader has not opted
    // in. The script stays resident only to answer the right-click menu and the
    // popup's "translate this page now", which cost nothing until used.
    if (siteOn()) startObserving();
    log.info(
      `observing=${observing} site=${siteOn()} reader=${onReaderPage()} prefetch=${Boolean(profile.prefetch)}`,
    );

    function nearViewport(r: DOMRect): boolean {
      const h = window.innerHeight;
      return r.bottom > -ROOT_MARGIN.above * h && r.top < h + ROOT_MARGIN.below * h;
    }
  },
});

function distance(img: HTMLImageElement, centre: number): number {
  const rect = img.getBoundingClientRect();
  // A preloaded page has no box; treat it as far away but still reachable, so
  // visible pages always win.
  if (rect.width === 0) return 1e6;
  return Math.abs(rect.top + rect.height / 2 - centre);
}

function inViewport(img: HTMLImageElement): boolean {
  const r = img.getBoundingClientRect();
  return r.width > 0 && r.bottom > 0 && r.top < window.innerHeight;
}

function stageLabel(stage: string): string {
  return (
    { acquire: 'กำลังดึงภาพ', detect: 'กำลังหากล่องข้อความ', translate: 'กำลังแปล', done: 'เสร็จ' }[
      stage
    ] ?? stage
  );
}
