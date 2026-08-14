import { defineBackground } from 'wxt/utils/define-background';
import { cacheStats, clearCache } from '../cache/stores';
import { runJob } from '../background/pipeline';
import { callOffscreen, ensureOffscreen } from '../background/offscreen-manager';
import { clearTransfers } from '../shared/blob-bridge';
import { HINTS_TH, toErrorPayload } from '../shared/errors';
import { makeLog } from '../shared/log';
import type {
  ContentToSw,
  DiagnosticLine,
  Request,
  Response,
  SwToContent,
  SwToTab,
} from '../shared/messages';
import { PORT_NAME } from '../shared/messages';
import { loadSettings, onSettingsChanged } from '../shared/settings';
import { GeminiProvider } from '../translation/GeminiProvider';

const log = makeLog('sw');

const MENU_ID = 'mt-translate-image';

/**
 * The orchestrator.
 *
 * Everything that must not run in the page lives here: cross-origin image
 * fetches (host_permissions exempts them from CORS), the Gemini call (a content
 * script would inherit the site's CSP), IndexedDB, and the offscreen document's
 * lifetime. The worker itself keeps nothing in module state that matters —
 * Chrome restarts it constantly.
 */
export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(async () => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: MENU_ID,
        title: 'แปลรูปนี้ (Manga Translator)',
        contexts: ['image'],
      });
    });
    // A transfer left parked by a job that died with the worker is dead weight.
    await clearTransfers();
    void chrome.runtime.openOptionsPage();
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID || tab?.id === undefined) return;
    const msg: SwToTab = { t: 'CONTEXT_TRANSLATE', srcUrl: info.srcUrl };
    void chrome.tabs.sendMessage(tab.id, msg).catch((err: unknown) => {
      log.warn('content script not present in this tab', err);
    });
  });

  /* ---------------- long-lived port: one per content script ---------------- */

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;

    const inflight = new Map<string, AbortController>();

    port.onMessage.addListener((raw: ContentToSw) => {
      if (raw.t === 'CANCEL') {
        inflight.get(raw.jobId)?.abort();
        return;
      }
      if (raw.t !== 'RUN') return;

      const controller = new AbortController();
      inflight.set(raw.jobId, controller);

      // Serialised globally: detection is GPU/CPU bound and running two pages at
      // once makes both slower while making the visible one arrive later.
      void enqueue(async () => {
        try {
          const settings = await loadSettings();
          const outcome = await runJob(
            raw.source,
            settings,
            (stage, detail) => post(port, { t: 'PROGRESS', jobId: raw.jobId, stage, ...(detail ? { detail } : {}) }),
            controller.signal,
          );
          post(port, {
            t: 'RESULT',
            jobId: raw.jobId,
            hash: outcome.hash,
            natural: outcome.natural,
            blocks: outcome.blocks,
            fromCache: outcome.fromCache,
            warning: outcome.warning,
          });
        } catch (err) {
          const payload = toErrorPayload(err);
          log.warn(`job ${raw.jobId} failed: ${payload.code} ${payload.message}`);
          post(port, { t: 'ERROR', jobId: raw.jobId, ...payload });
        } finally {
          inflight.delete(raw.jobId);
        }
      });
    });

    port.onDisconnect.addListener(() => {
      for (const c of inflight.values()) c.abort();
      inflight.clear();
    });
  });

  /* ---------------- one-shot requests from popup / options ---------------- */

  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    // Offscreen traffic uses an envelope; ignore it here so the two routers do
    // not answer each other's messages.
    if ((raw as { __to?: string })?.__to) return false;

    handleRequest(raw as Request)
      .then(sendResponse)
      .catch((err: unknown) => sendResponse({ ok: false, ...toErrorPayload(err) } satisfies Response));
    return true;
  });

  onSettingsChanged((settings) => {
    void chrome.tabs.query({}).then((tabs) => {
      for (const tab of tabs) {
        if (tab.id === undefined) continue;
        void chrome.tabs.sendMessage(tab.id, { t: 'SETTINGS_CHANGED' } satisfies SwToTab).catch(() => {
          /* no content script here */
        });
      }
    });
    if (settings.enabled) void prewarm();
  });
});

/* ---------------- helpers ---------------- */

let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = chain.then(task, task);
  chain = next.catch(() => undefined);
  return next;
}

function post(port: chrome.runtime.Port, msg: SwToContent): void {
  try {
    port.postMessage(msg);
  } catch {
    // The tab navigated away mid-job. Nothing to do and nothing worth logging.
  }
}

async function prewarm(): Promise<void> {
  const settings = await loadSettings();
  try {
    await callOffscreen({
      t: 'OFF_PREWARM',
      runtime: settings.ocr.runtime,
      dilateRatio: settings.ocr.dilateRatio,
    });
  } catch (err) {
    log.warn('prewarm failed', err);
  }
}

async function handleRequest(req: Request): Promise<Response> {
  switch (req?.t) {
    case 'PING':
      return { ok: true, pong: true };

    case 'PREWARM':
      await prewarm();
      return { ok: true };

    case 'DIAGNOSE':
      return { ok: true, lines: await diagnose() };

    case 'TEST_KEY': {
      const provider = new GeminiProvider({
        apiKey: req.apiKey,
        model: req.model,
        from: 'ja',
        to: 'th',
        safetyOff: true,
      });
      // A trivial round trip is the only way to distinguish "key looks like a
      // key" from "key actually works", which is the question the user has.
      await provider.translateBatch(['テスト']);
      return { ok: true };
    }

    case 'CACHE_STATS':
      return { ok: true, stats: await cacheStats() };

    case 'CACHE_CLEAR':
      await clearCache(req.which);
      return { ok: true };

    case 'TRANSLATE_VISIBLE':
      await chrome.tabs.sendMessage(req.tabId, { t: 'TRANSLATE_VISIBLE' } satisfies SwToTab);
      return { ok: true };

    default:
      return { ok: false, code: 'UNKNOWN', message: `unknown request ${String(req?.t)}`, hint: '' };
  }
}

/**
 * One button, one answer per subsystem, and a fix on every failing line.
 *
 * This is the feature that decides whether handing the extension to a friend
 * costs an afternoon of "what does the error say?" or one screenshot.
 */
async function diagnose(): Promise<DiagnosticLine[]> {
  const lines: DiagnosticLine[] = [];
  const settings = await loadSettings();

  try {
    await ensureOffscreen();
    lines.push({
      id: 'offscreen',
      label: 'ตัวประมวลผลเบื้องหลัง',
      status: 'ok',
      detail: 'เปิดได้ปกติ',
      fix: '',
    });
  } catch (err) {
    lines.push({
      id: 'offscreen',
      label: 'ตัวประมวลผลเบื้องหลัง',
      status: 'fail',
      detail: String(err),
      fix: HINTS_TH.OFFSCREEN_FAILED,
    });
    return lines; // everything below needs it
  }

  try {
    const reply = await callOffscreen({ t: 'OFF_CAPS' });
    const caps = 'caps' in reply ? reply.caps : null;

    lines.push({
      id: 'webgpu',
      label: 'WebGPU',
      status: caps?.webgpu ? 'ok' : 'warn',
      detail: caps?.webgpu ? `ใช้ได้ ${caps.adapter}` : 'ไม่มี — จะใช้ WASM แทน',
      fix: caps?.webgpu
        ? ''
        : 'เปิด chrome://gpu ดูว่า WebGPU ถูกปิดไหม · WASM ยังใช้ได้แต่ช้ากว่าประมาณ 5 เท่า',
    });

    lines.push({
      id: 'model',
      label: 'โมเดลตรวจจับข้อความ',
      status: caps && caps.modelBytes > 0 ? 'ok' : 'warn',
      detail:
        caps && caps.modelBytes > 0
          ? `ดาวน์โหลดแล้ว ${(caps.modelBytes / 1e6).toFixed(1)} MB`
          : 'ยังไม่ได้ดาวน์โหลด (4.7 MB — จะโหลดอัตโนมัติครั้งแรกที่แปล)',
      fix: caps && caps.modelBytes > 0 ? '' : 'กด "อุ่นเครื่อง" ในหน้านี้ หรือแปลรูปสักหน้าหนึ่ง',
    });
  } catch (err) {
    lines.push({
      id: 'webgpu',
      label: 'WebGPU / โมเดล',
      status: 'fail',
      detail: String(err),
      fix: HINTS_TH.MODEL_LOAD_FAILED,
    });
  }

  const key = settings.translation.gemini.apiKey.trim();
  if (!key) {
    lines.push({
      id: 'apikey',
      label: 'Gemini API key',
      status: 'fail',
      detail: 'ยังไม่ได้ใส่',
      fix: 'ขอ key ฟรีที่ https://aistudio.google.com/apikey แล้ววางในหน้านี้',
    });
  } else {
    try {
      const provider = new GeminiProvider({
        apiKey: key,
        model: settings.translation.gemini.model,
        from: 'ja',
        to: settings.lang.target,
        safetyOff: settings.translation.gemini.safetyOff,
      });
      await provider.translateBatch(['テスト']);
      lines.push({
        id: 'apikey',
        label: 'Gemini API key',
        status: 'ok',
        detail: `ใช้ได้ · โมเดล ${settings.translation.gemini.model}`,
        fix: '',
      });
    } catch (err) {
      const payload = toErrorPayload(err);
      lines.push({
        id: 'apikey',
        label: 'Gemini API key',
        status: 'fail',
        detail: `${payload.code}: ${payload.message}`,
        fix: payload.hint,
      });
    }
  }

  try {
    const stats = await cacheStats();
    lines.push({
      id: 'cache',
      label: 'แคช',
      status: 'ok',
      detail: `${stats.ocrRecords} หน้า · ${stats.translationRecords} ประโยค · ${(stats.bytes / 1e6).toFixed(1)} MB / 200 MB`,
      fix: '',
    });
  } catch (err) {
    lines.push({
      id: 'cache',
      label: 'แคช',
      status: 'fail',
      detail: String(err),
      fix: 'กด "ล้างแคช" ในหน้านี้ ถ้ายังไม่หายให้ลบแล้วติดตั้ง extension ใหม่',
    });
  }

  return lines;
}
