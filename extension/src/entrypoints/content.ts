import { defineContentScript } from 'wxt/utils/define-content-script';
import { acquire } from '../content/acquire';
import { Overlay } from '../content/overlay/overlay';
import { elementKey, isLoaded, isPageCandidate, pageShape, scanImages } from '../content/scan';
import { profileFor } from '../content/site-profiles';
import { classifyPage } from '../core/page-kind';
import { MAX_CONSECUTIVE_MISSES, pickPrefetch } from '../core/prefetch';
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
      /** Gallery page a speculative job was guessed for; null for real work. */
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
    const queue: HTMLImageElement[] = [];

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
      // Asking again for a page that already has a translation can only mean the
      // translation was not good enough, so that is the one case worth spending
      // a fresh request on. A first manual request still uses the cache.
      if (!manual && alreadyDone) return;
      if (manual && alreadyDone) redo.add(img);

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

      if (!queue.includes(img)) queue.push(img);
      pump();
    }

    /** Attach an element to work that is already in flight. */
    function adopt(job: Job, img: HTMLImageElement): void {
      if (job.speculative) log.debug(`adopted prefetch of page ${job.page} — the reader arrived`);
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
      // One at a time: detection is GPU/CPU bound and a second concurrent page
      // only makes the one the user is looking at arrive later.
      if (running >= settings.performance.maxConcurrentOcr || queue.length === 0) return;

      // Re-sort every time rather than keeping a heap: the list is a handful of
      // images and the priority (distance from the middle of the viewport)
      // changes on every scroll anyway.
      const centre = window.innerHeight / 2;
      queue.sort((a, b) => distance(a, centre) - distance(b, centre));

      const img = queue.shift();
      if (!img) return;
      if (!img.isConnected || !isLoaded(img)) return pump();

      running++;
      void run(img).finally(() => {
        running--;
        pump();
      });
    }

    async function run(img: HTMLImageElement): Promise<void> {
      const key = srcOf(img);

      // The prefetcher may have started this page while it sat in the queue.
      const running = byKey.get(key);
      if (running) {
        adopt(running, img);
        return;
      }

      const job: Job = {
        id: `j${++jobCounter}`,
        key,
        imgs: new Set([img]),
        speculative: false,
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

    function speculativeInFlight(): number {
      let n = 0;
      for (const job of active.values()) if (job.speculative) n++;
      return n;
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
      }

      const page = profile.pageNumber?.(url) ?? null;
      const pick = pickPrefetch({
        now: Date.now(),
        enabled: auto(),
        lookahead: settings.performance.prefetchLookahead,
        visible: document.visibilityState === 'visible',
        foregroundWaiting: queue.length > 0,
        inFlight: speculativeInFlight(),
        consecutiveMisses: prefetchMisses,
        lastStartAt: prefetchLastStart,
        currentPage: page,
        totalPages: cfg.total(document),
        covered: prefetchCovered,
      });
      if (pick === null || page === null) return;

      const shown = scanImages(profile).find(isLoaded);
      const guess = shown ? cfg.imageUrl(srcOf(shown), pick - page) : null;
      if (!guess) return;
      if (byKey.has(guess)) {
        // The reader is already on it, or another element asked for it first.
        prefetchCovered.add(pick);
        return;
      }

      // Marked covered before the request, so a failure is not retried in a loop.
      prefetchCovered.add(pick);
      prefetchLastStart = Date.now();

      const job: Job = {
        id: `p${++jobCounter}`,
        key: guess,
        imgs: new Set(),
        speculative: true,
        page: pick,
        stage: 'acquire',
      };
      active.set(job.id, job);
      byKey.set(guess, job);
      log.debug(`prefetch page ${pick}`);
      send({
        t: 'RUN',
        jobId: job.id,
        source: {
          elementKey: `prefetch-${pick}`,
          url: guess,
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
        if (job.speculative) prefetchMisses = 0;

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

      if (job.imgs.size > 0) {
        for (const img of job.imgs) overlay.status(img, msg.hint || msg.message, 'error');
      } else {
        // A prefetch that failed is not the reader's problem: they never asked
        // for that page and may never reach it. But a guessed URL that does not
        // exist says the pattern is wrong for this gallery, and guessing on is
        // just noise at someone else's server — so two in a row stop it.
        log.debug(`prefetch failed: ${msg.code} ${msg.message}`);
        if (msg.code === 'ACQUIRE_FAILED') {
          prefetchMisses++;
          if (prefetchMisses >= MAX_CONSECUTIVE_MISSES) {
            log.info(`prefetch off for this gallery after ${prefetchMisses} bad guesses`);
          }
        }
      }

      settle(job);
    }

    /* ---------------- observers ---------------- */

    // 200% above: on a long strip the user scrolls fast, so work has to start
    // roughly two screens before the image appears for the result to be there
    // when it does.
    const ROOT_MARGIN = { above: 2, below: 1 };
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

    addEventListener('pagehide', () => stopPrefetch(), { once: true });

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
