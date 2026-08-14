import type { PipelineResult } from '../types';

/**
 * Persist benchmark runs so results survive a reload.
 *
 * M0 compares backends, presets and recognizers, and those comparisons happen
 * across sessions — reading a wasm number off the screen, switching to webgpu,
 * then trying to remember what the first one said is how benchmarks turn into
 * vibes. Every run is recorded with the exact configuration that produced it,
 * because a timing without its config is not evidence of anything.
 *
 * localStorage, not IndexedDB: these records are small, and a spike should not
 * grow storage plumbing it will throw away. The extension uses IndexedDB.
 */

const KEY = 'mt.bench.runs';
const MAX_RUNS = 30;

export interface BenchPage {
  file: string;
  natural: { w: number; h: number };
  detSize: { w: number; h: number };
  blockCount: number;
  timings: PipelineResult['timings'];
  /** Recognized/translated text, so a later run can be diffed against this one. */
  blocks: { text: string; source?: string; direction: string; score: number }[];
  warning: string | null;
}

export interface BenchRun {
  id: string;
  startedAt: number;
  config: {
    lang: string;
    preset: string;
    detector: string;
    recognizer: string;
    backend: string;
  };
  env: {
    webgpu: boolean;
    cores: number;
    crossOriginIsolated: boolean;
  };
  pages: BenchPage[];
  /** Wall-clock totals per page, in run order. */
  totals: number[];
}

function read(): BenchRun[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as BenchRun[]) : [];
  } catch {
    // A corrupt entry should cost you your history, not the whole harness.
    return [];
  }
}

function write(runs: BenchRun[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(runs.slice(0, MAX_RUNS)));
  } catch (err) {
    // Quota is the likely cause; drop the oldest half and retry once.
    console.warn('[bench] save failed, trimming history', err);
    try {
      localStorage.setItem(KEY, JSON.stringify(runs.slice(0, Math.floor(MAX_RUNS / 2))));
    } catch {
      /* give up quietly — losing history must never break a run */
    }
  }
}

export function listRuns(): BenchRun[] {
  return read().sort((a, b) => b.startedAt - a.startedAt);
}

export function saveRun(run: BenchRun): void {
  write([run, ...read().filter((r) => r.id !== run.id)]);
}

export function getRun(id: string): BenchRun | undefined {
  return read().find((r) => r.id === id);
}

export function clearRuns(): void {
  localStorage.removeItem(KEY);
}

/** Turn a pipeline result into the storable shape. */
export function toBenchPage(
  file: string,
  result: PipelineResult & { warning: string | null },
): BenchPage {
  return {
    file,
    natural: result.natural,
    detSize: result.detSize,
    blockCount: result.blocks.length,
    timings: result.timings,
    blocks: result.blocks.map((b) => ({
      text: b.text,
      ...(b.source ? { source: b.source } : {}),
      direction: b.direction,
      score: Number(b.score.toFixed(3)),
    })),
    warning: result.warning,
  };
}

/**
 * Download a run as JSON.
 *
 * The point is comparison outside the harness — pasting into an ADR, diffing
 * two configurations, or handing numbers to someone who was not at the machine.
 */
export function exportRun(run: BenchRun): void {
  const stamp = new Date(run.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `bench-${run.config.recognizer}-${run.config.backend}-${stamp}.json`;

  const url = URL.createObjectURL(
    new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Revoke on the next task so the click has already been handled.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Median wall-clock ms for a run — the headline number. */
export function medianTotal(run: BenchRun): number {
  const sorted = [...run.totals].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
