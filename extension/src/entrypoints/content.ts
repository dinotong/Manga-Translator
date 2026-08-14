import { defineContentScript } from 'wxt/utils/define-content-script';
import { acquire } from '../content/acquire';
import { Overlay } from '../content/overlay/overlay';
import { elementKey, isLoaded, scanImages } from '../content/scan';
import { profileFor } from '../content/site-profiles';
import { toErrorPayload } from '../shared/errors';
import { makeLog } from '../shared/log';
import {
  type ContentToSw,
  type JobSource,
  PORT_NAME,
  type SwToContent,
  type SwToTab,
} from '../shared/messages';
import { loadSettings, type Settings } from '../shared/settings';

const log = makeLog('content');

/**
 * The page side.
 *
 * Everything here is driven by visibility and mutation, never by scroll events.
 * Both target sites are paged readers: on MangaDex the user clicks through pages
 * and the scroll handler would essentially never fire, and imhentai replaces the
 * image without any scrolling at all. "Auto translate on scroll" is really
 * "auto translate on visibility change".
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  async main() {
    if (window.top !== window) return; // ad iframes are never manga pages

    let settings = await loadSettings();
    const profile = profileFor(new URL(location.href));
    log.info(`profile=${profile.id} acquire=${profile.acquire}`);

    const overlay = new Overlay(settings);

    /** Jobs in flight or queued, keyed by element. */
    const jobs = new Map<HTMLImageElement, string>();
    const byJob = new Map<string, HTMLImageElement>();
    /** Elements already done at their current src, so a re-scan is free. */
    const done = new WeakMap<HTMLImageElement, string>();
    const queue: HTMLImageElement[] = [];
    let running = 0;
    let lastContextTarget: HTMLImageElement | null = null;
    let jobCounter = 0;

    /* ---------------- scheduling ---------------- */

    /** Elements the user asked for a second time — those skip the cache. */
    const redo = new Set<HTMLImageElement>();

    function enqueue(img: HTMLImageElement, manual = false): void {
      if (!isLoaded(img) || jobs.has(img)) return;
      const src = img.currentSrc || img.src;
      const alreadyDone = done.get(img) === src;
      if (!manual && alreadyDone) return;
      // Asking again for a page that already has a translation can only mean
      // the translation was not good enough, so that is the one case worth
      // spending a fresh request on. A first manual request still uses the
      // cache — re-reading an image the user has seen before would burn quota
      // for an identical answer.
      if (manual && alreadyDone) redo.add(img);
      if (!queue.includes(img)) queue.push(img);
      pump();
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
      if (!img || !img.isConnected) return pump();

      running++;
      void run(img).finally(() => {
        running--;
        pump();
      });
    }

    async function run(img: HTMLImageElement): Promise<void> {
      const jobId = `j${++jobCounter}`;
      jobs.set(img, jobId);
      byJob.set(jobId, img);
      overlay.status(img, 'กำลังอ่านภาพ…');

      let source: JobSource;
      try {
        const got = await acquire(img, profile);
        source = {
          elementKey: elementKey(img),
          url: got.kind === 'url' ? got.url : img.currentSrc || img.src,
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
        jobs.delete(img);
        byJob.delete(jobId);
        return; // must not await a reply that will never come — it would stall the queue
      }

      // Hold the slot until the worker answers, so maxConcurrentOcr means what
      // it says rather than counting only the acquisition.
      const settled = new Promise<void>((resolve) => waiters.set(jobId, resolve));
      send({ t: 'RUN', jobId, source });
      await settled;
    }

    const waiters = new Map<string, () => void>();

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
      const img = byJob.get(msg.jobId);
      if (!img) return;

      if (msg.t === 'PROGRESS') {
        overlay.status(img, `${stageLabel(msg.stage)}${msg.detail ? ` · ${msg.detail}` : ''}`);
        return;
      }

      if (msg.t === 'RESULT') {
        overlay.setResult(msg.hash, msg.natural, msg.blocks);
        overlay.attach(img, msg.hash);
        overlay.status(
          img,
          msg.warning ?? (msg.fromCache ? '' : `แปลแล้ว ${msg.blocks.length} กล่อง`),
          msg.warning ? 'error' : 'info',
        );
        if (!msg.warning) setTimeout(() => overlay.status(img, ''), 1600);
        done.set(img, img.currentSrc || img.src);
      } else {
        overlay.status(img, msg.hint || msg.message, 'error');
      }

      jobs.delete(img);
      byJob.delete(msg.jobId);
      waiters.get(msg.jobId)?.();
      waiters.delete(msg.jobId);
    }

    /* ---------------- observers ---------------- */

    const seen = new Set<HTMLImageElement>();

    // 200% above: on a long strip the user scrolls fast, so work has to start
    // roughly two screens before the image appears for the result to be there
    // when it does.
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (settings.enabled && settings.autoTranslate) {
            enqueue(entry.target as HTMLImageElement);
          }
        }
      },
      { rootMargin: '200% 0px 100% 0px', threshold: 0.01 },
    );

    function rescan(): void {
      for (const img of scanImages(profile)) {
        if (seen.has(img)) continue;
        seen.add(img);
        io.observe(img);
        // A preloaded page sitting at 0x0 never intersects, but it is exactly
        // the page the user is about to open — so translate it now and the page
        // turn is a cache hit.
        if (settings.enabled && settings.autoTranslate && img.getBoundingClientRect().width === 0) {
          enqueue(img);
        }
      }
    }

    const mo = new MutationObserver((records) => {
      let structural = false;
      for (const r of records) {
        if (r.type === 'attributes' && r.target instanceof HTMLImageElement) {
          // The page turned on a reused element. Drop the old translation
          // immediately — leaving it up for even one frame means showing the
          // wrong page's dialogue.
          overlay.invalidate(r.target);
          overlay.status(r.target, '');
          done.delete(r.target);
          if (settings.enabled && settings.autoTranslate) enqueue(r.target);
        } else if (r.type === 'childList' && r.addedNodes.length > 0) {
          structural = true;
        }
      }
      if (structural) debounceRescan();
    });

    let rescanTimer: ReturnType<typeof setTimeout> | undefined;
    function debounceRescan(): void {
      clearTimeout(rescanTimer);
      rescanTimer = setTimeout(rescan, 150);
    }

    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'data-src', 'data-original'],
    });

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
        overlay.clearAll();
        seen.clear();
        debounceRescan();
      });
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
          enqueue(img, true);
        } else {
          log.warn('right-clicked image not found in this document');
        }
      } else if (msg?.t === 'TRANSLATE_VISIBLE') {
        for (const img of scanImages(profile)) {
          if (inViewport(img)) enqueue(img, true);
        }
      } else if (msg?.t === 'SETTINGS_CHANGED') {
        void loadSettings().then((next) => {
          settings = next;
          overlay.updateSettings(next);
          if (!next.enabled) overlay.clearAll();
          else if (next.autoTranslate) rescan();
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

    rescan();
    log.info(`watching ${seen.size} candidate image(s)`);
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
