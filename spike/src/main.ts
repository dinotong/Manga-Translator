import type { PresetName } from './core/resolution';
import { GeminiVisionReader } from './ocr/GeminiVisionReader';
import { MangaOcrRecognizer } from './ocr/MangaOcrRecognizer';
import { MockDetector, MockRecognizer } from './ocr/mock';
import { type DetBackend, PpOcrDetector } from './ocr/PpOcrDetector';
import { ModelNotDownloadedError, type TextDetector, type TextRecognizer } from './ocr/types';
import { runPipeline } from './pipeline';
import {
  type BenchPage,
  clearRuns,
  exportRun,
  getRun,
  listRuns,
  medianTotal,
  saveRun,
  toBenchPage,
} from './bench/store';
import { exportAllCards } from './ui/export-png';
import { renderResult, renderStoredRun, renderSummary } from './ui/render';
import type { LangCode } from './types';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const els = {
  lang: $<HTMLSelectElement>('lang'),
  preset: $<HTMLSelectElement>('preset'),
  detector: $<HTMLSelectElement>('detector'),
  recognizer: $<HTMLSelectElement>('recognizer'),
  backend: $<HTMLSelectElement>('backend'),
  dilate: $<HTMLSelectElement>('dilate'),
  nms: $<HTMLSelectElement>('nms'),
  apiKey: $<HTMLInputElement>('api-key'),
  runSamples: $<HTMLButtonElement>('run-samples'),
  exportPng: $<HTMLButtonElement>('export-png'),
  boxesOnly: $<HTMLInputElement>('boxes-only'),
  history: $<HTMLSelectElement>('history'),
  loadRun: $<HTMLButtonElement>('load-run'),
  exportRun: $<HTMLButtonElement>('export-run'),
  clearRuns: $<HTMLButtonElement>('clear-runs'),
  historyNote: $('history-note'),
  file: $<HTMLInputElement>('file'),
  drop: $('drop'),
  warning: $('warning'),
  results: $('results'),
};

// Models are expensive to load, so engines are built once and reused across
// runs. First-load cost is measured separately and reported on its own.
const engines = new Map<string, TextDetector | TextRecognizer>();

function makeGemini(): GeminiVisionReader {
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    throw new Error('ใส่ Gemini API key ก่อน (ฟรี ไม่ต้องผูกบัตร — aistudio.google.com/apikey)');
  }
  // Local only, never committed: this is the user's own key.
  localStorage.setItem('mt.geminiKey', apiKey);
  return new GeminiVisionReader({ apiKey, sourceLang: els.lang.value as LangCode });
}

async function getDetector(kind: string): Promise<TextDetector> {
  const backend = els.backend.value as DetBackend;
  // Backend is part of the identity: a wasm session and a webgpu session are
  // different engines, and comparing them is the entire point of M0.
  const key = `det:${kind}:${backend}`;

  // Dilate and NMS are post-processing, so they are applied to whichever
  // detector we end up with rather than being part of its cache key. Sweeping
  // them must not pay the ~1.7 s WebGPU shader compile again on every step.
  const tune = (d: TextDetector): TextDetector => {
    if (d instanceof PpOcrDetector) {
      d.setPostprocess({
        dilateRatio: Number(els.dilate.value),
        nmsIou: Number(els.nms.value),
      });
    }
    return d;
  };

  const cached = engines.get(key) as TextDetector | undefined;
  if (cached) return tune(cached);

  const detector: TextDetector =
    kind === 'ppocr' ? new PpOcrDetector({ backend }) : new MockDetector();

  const t0 = performance.now();
  await detector.init((f) => note(`โหลดโมเดล ${detector.id}… ${(f * 100).toFixed(0)}%`));
  const loadMs = performance.now() - t0;

  const active = detector instanceof PpOcrDetector ? ` · backend=${detector.backend}` : '';
  console.info(`[load] ${detector.id} ${loadMs.toFixed(0)}ms${active}`);
  note(`โหลด ${detector.id} เสร็จใน ${(loadMs / 1000).toFixed(1)}s${active}`);

  engines.set(key, detector);
  return tune(detector);
}

async function getRecognizer(kind: string): Promise<TextRecognizer> {
  const device = els.backend.value === 'wasm' ? 'wasm' : 'webgpu';
  // Language is part of the identity for Gemini — the prompt is built from it.
  const key = `rec:${kind}:${device}:${els.lang.value}`;

  const cached = engines.get(key) as TextRecognizer | undefined;
  if (cached) return cached;

  const recognizer: TextRecognizer =
    kind === 'gemini'
      ? makeGemini()
      : kind.startsWith('mangaocr')
        ? new MangaOcrRecognizer({ device })
        : new MockRecognizer();

  const t0 = performance.now();
  await recognizer.init((f) =>
    note(`โหลด ${recognizer.id}… ${(f * 100).toFixed(0)}% (ครั้งแรก ~117 MB)`),
  );
  const loadMs = performance.now() - t0;

  const active = recognizer instanceof MangaOcrRecognizer ? ` · device=${recognizer.device}` : '';
  console.info(`[load] ${recognizer.id} ${loadMs.toFixed(0)}ms${active}`);
  note(`โหลด ${recognizer.id} เสร็จใน ${(loadMs / 1000).toFixed(1)}s${active}`);

  engines.set(key, recognizer);
  return recognizer;
}

function note(message: string | null): void {
  els.warning.hidden = message === null;
  els.warning.textContent = message ?? '';
}

let running = false;

async function processFiles(files: readonly File[]): Promise<void> {
  const images = files.filter((f) => f.type.startsWith('image/'));
  if (images.length === 0 || running) return;

  running = true;
  note(`กำลังประมวลผล ${images.length} ไฟล์…`);

  const lang = els.lang.value as LangCode;
  const preset = els.preset.value as PresetName;

  // Engine setup must not escape the running flag: an early throw here (missing
  // API key, model not downloaded) used to leave `running` stuck true, so every
  // later click was silently ignored — including the one after the key was
  // finally entered.
  let detector: TextDetector;
  let recognizer: TextRecognizer;
  try {
    detector = await getDetector(els.detector.value);
    recognizer = await getRecognizer(els.recognizer.value);
  } catch (err) {
    note(err instanceof Error ? err.message : String(err));
    console.error('engine setup failed', err);
    running = false;
    return;
  }

  const totals: number[] = [];
  const warnings = new Set<string>();
  const pages: BenchPage[] = [];
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  for (const file of images) {
    const url = URL.createObjectURL(file);
    try {
      const result = await runPipeline(
        file,
        {
          detector,
          recognizer,
          // Text mode: local OCR reads the page, and only the strings are sent.
          ...(els.recognizer.value === 'mangaocr-gemini' ? { translator: makeGemini() } : {}),
          onProgress: (stage, detail) =>
            note(`${file.name} — ${stage}${detail ? ` (${detail})` : ''}`),
        },
        { lang, preset, rtl: lang === 'ja' || lang === 'zh' },
      );

      totals.push(result.timings.total);
      if (result.warning) warnings.add(result.warning);
      pages.push(toBenchPage(file.name, result));
      renderResult(els.results, file.name, url, result);
    } catch (err) {
      URL.revokeObjectURL(url);
      console.error(file.name, err);

      // A missing model is a setup problem, not a bad file — stop rather than
      // failing the same way ten more times.
      if (err instanceof ModelNotDownloadedError) {
        note(`${err.message}`);
        break;
      }
      // Otherwise keep going: one unreadable page should not end the batch.
      note(`${file.name} — ล้มเหลว: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  renderSummary(els.results, totals);

  // Save even a partial run: a run that died halfway is still evidence.
  if (pages.length > 0) {
    saveRun({
      id: runId,
      startedAt: Date.now(),
      config: {
        lang,
        preset,
        detector: els.detector.value,
        recognizer: els.recognizer.value,
        backend: els.backend.value,
        dilate: Number(els.dilate.value),
        nms: Number(els.nms.value),
      },
      env: {
        webgpu: 'gpu' in navigator,
        cores: navigator.hardwareConcurrency,
        crossOriginIsolated: globalThis.crossOriginIsolated,
      },
      pages,
      totals,
    });
    refreshHistory();
  }

  note(warnings.size > 0 ? [...warnings].join(' · ') : null);
  running = false;
}

els.file.addEventListener('change', () => {
  void processFiles([...(els.file.files ?? [])]);
});

/** Pull the whole fixture set from the dev server so a benchmark run is one click. */
async function loadSamples(): Promise<File[]> {
  const res = await fetch('/samples/index.json');
  if (!res.ok) throw new Error('samples/ ว่างหรือเข้าไม่ถึง');
  const names: string[] = await res.json();

  return Promise.all(
    names.map(async (name) => {
      const blob = await (await fetch(`/samples/${encodeURIComponent(name)}`)).blob();
      return new File([blob], name, { type: blob.type });
    }),
  );
}

els.runSamples.addEventListener('click', () => {
  void (async () => {
    try {
      const files = await loadSamples();
      if (files.length === 0) {
        note('ไม่มีไฟล์ใน spike/samples/ — ดู README');
        return;
      }
      await processFiles(files);
    } catch (err) {
      note(err instanceof Error ? err.message : String(err));
    }
  })();
});

els.drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.drop.classList.add('over');
});
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  els.drop.classList.remove('over');
  void processFiles([...(e.dataTransfer?.files ?? [])]);
});

// Restore the key so it survives a reload. localStorage only — this is a dev
// harness on localhost, and the extension will use chrome.storage.local with an
// explicit warning that an extension-stored key is not a secret.
els.apiKey.value = localStorage.getItem('mt.geminiKey') ?? '';

// Dev convenience: pick up the key from spike/.env when the field is empty.
// The endpoint only exists on the dev server, so this is a no-op in a build.
if (!els.apiKey.value) {
  void fetch('/dev/config')
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg: { geminiApiKey?: string } | null) => {
      if (cfg?.geminiApiKey) {
        els.apiKey.value = cfg.geminiApiKey;
        els.apiKey.placeholder = 'โหลดจาก .env';
      }
    })
    .catch(() => {
      /* no dev server config — the user types a key instead */
    });
}

// --- overlay visibility -----------------------------------------------------

els.boxesOnly.addEventListener('change', () => {
  els.results.classList.toggle('boxes-only', els.boxesOnly.checked);
});

els.exportPng.addEventListener('click', () => {
  void (async () => {
    els.exportPng.disabled = true;
    try {
      const saved = await exportAllCards(els.results, (done, total) =>
        note(`กำลังเรนเดอร์ PNG ${done}/${total}…`),
      );
      note(saved === 0 ? 'ยังไม่มีหน้าที่รันไว้' : `บันทึกแล้ว ${saved} ไฟล์`);
    } catch (err) {
      note(err instanceof Error ? err.message : String(err));
      console.error('png export failed', err);
    } finally {
      els.exportPng.disabled = false;
    }
  })();
});

// --- run history ------------------------------------------------------------

function refreshHistory(): void {
  const runs = listRuns();
  els.history.innerHTML = runs
    .map((r) => {
      const when = new Date(r.startedAt).toLocaleString();
      const median = (medianTotal(r) / 1000).toFixed(2);
      return `<option value="${r.id}">${when} · ${r.config.recognizer}/${r.config.backend} · ${r.pages.length} หน้า · median ${median}s</option>`;
    })
    .join('');

  const empty = runs.length === 0;
  els.loadRun.disabled = empty;
  els.exportRun.disabled = empty;
  els.clearRuns.disabled = empty;
  els.historyNote.textContent = empty ? 'ยังไม่มีผลที่บันทึกไว้' : `${runs.length} รายการ`;
}

els.loadRun.addEventListener('click', () => {
  const run = getRun(els.history.value);
  if (!run) return;
  // Restored runs show numbers and text only — the fixture images are never
  // stored, so there is nothing to overlay them onto.
  renderStoredRun(els.results, run);
  note(`แสดงผลที่บันทึกไว้ · ${new Date(run.startedAt).toLocaleString()}`);
});

els.exportRun.addEventListener('click', () => {
  const run = getRun(els.history.value);
  if (run) exportRun(run);
});

els.clearRuns.addEventListener('click', () => {
  clearRuns();
  refreshHistory();
  note('ล้างประวัติแล้ว');
});

refreshHistory();

// Report what the machine can actually do, since it decides the WASM-vs-sidecar
// call as much as the model does.
void (async () => {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
  console.info('[env]', {
    webgpu: adapter ? 'available' : 'unavailable',
    crossOriginIsolated: globalThis.crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
  });
  if (!adapter) {
    note('WebGPU ใช้ไม่ได้ในเบราว์เซอร์นี้ — benchmark จะวัดได้แค่ WASM');
  }
})();
