import type { BenchRun } from '../bench/store';
import { fmtMs, summarize } from '../bench/timer';
import type { PipelineResult } from '../types';

/**
 * Boxes are positioned in percent inside a container sized by the image itself.
 *
 * That is not a shortcut for the harness — it is the extension's overlay
 * strategy rehearsed early. Coordinates come out of the pipeline normalized, so
 * `left: 42%` lands correctly at any rendered size with no JS on resize. If it
 * is going to break, better to find out here.
 */
export function renderResult(
  root: HTMLElement,
  fileName: string,
  imageUrl: string,
  result: PipelineResult & { warning: string | null },
): void {
  const { timings: t, blocks } = result;
  const perBlock = summarize(t.perBlock);
  const card = document.createElement('article');
  card.className = 'card';

  const boxes = blocks.map((b, i) => renderBox(b, i, result.natural)).join('');

  const rows: [string, number, boolean][] = [
    ['decode + resize', t.decode, false],
    ['detect', t.detect, false],
    ['group', t.group, false],
    // Recognition is the number that decides the architecture, so flag it when
    // it dominates.
    ['recognize', t.recognize, t.recognize > t.total * 0.6],
    ['total', t.total, false],
  ];

  card.innerHTML = `
    <h2>
      <span>${escapeHtml(fileName)}</span>
      <span class="meta">${result.natural.w}x${result.natural.h} → det ${result.detSize.w}x${result.detSize.h} · ${blocks.length} blocks</span>
    </h2>
    <div class="card-body">
      <div class="stage">
        <img src="${imageUrl}" alt="" />
        <div class="layer">${boxes}</div>
      </div>
      <div>
        <div class="side">
          <h3>Timings</h3>
          <table>
            ${rows.map(([k, v, hot]) => `<tr class="${hot ? 'hot' : ''}"><td>${k}</td><td>${fmtMs(v)}</td></tr>`).join('')}
            ${
              perBlock.n > 0
                ? `<tr><td>per block (median)</td><td>${fmtMs(perBlock.median)}</td></tr>
                   <tr><td>per block (max)</td><td>${fmtMs(perBlock.max)}</td></tr>`
                : ''
            }
          </table>
          ${verdict(t.total)}
        </div>
        <div class="side">
          <h3>Text (reading order)</h3>
          <ol class="blocks">
            ${
              blocks.length === 0
                ? '<li class="dir">ไม่พบข้อความ</li>'
                : blocks
                    .map(
                      (b) =>
                        `<li>${escapeHtml(b.text)} <span class="dir">${b.direction}${b.score < 0.7 ? ` · low ${b.score.toFixed(2)}` : ''}</span></li>`,
                    )
                    .join('')
            }
          </ol>
        </div>
        <div class="side">
          <h3>Engines</h3>
          <table>
            <tr><td>detector</td><td>${escapeHtml(result.detectorId)}</td></tr>
            <tr><td>recognizer</td><td>${escapeHtml(result.recognizerId)}</td></tr>
          </table>
        </div>
      </div>
    </div>`;

  root.prepend(card);
}

/** The M0 gate, applied per page so it is visible while you work, not just at the end. */
function verdict(totalMs: number): string {
  const s = totalMs / 1000;
  if (s <= 5) return `<div class="verdict ok">✅ ${s.toFixed(1)}s/page — WASM ไหว ไปต่อ M1 ได้</div>`;
  if (s <= 10)
    return `<div class="verdict warn">⚠️ ${s.toFixed(1)}s/page — ต้องใช้ preload margin กว้าง + progress</div>`;
  return `<div class="verdict bad">🔴 ${s.toFixed(1)}s/page — ต้องทำ Local Service ก่อน</div>`;
}

/**
 * One overlay box, with the translated text laid into it.
 *
 * This is the extension's overlay strategy rehearsed early: geometry in
 * percentages so it survives any rendered size, and font size in `cqw` so the
 * text scales with the image instead of needing JS on resize. If this breaks
 * when the window is dragged, better to find out in the harness than in M2.
 */
function renderBox(
  b: PipelineResult['blocks'][number],
  index: number,
  natural: { w: number; h: number },
): string {
  const pct = (v: number) => (v * 100).toFixed(3);

  // Font size in cqw, from how much text actually has to fit.
  //
  // Two unit traps live here, and the first version fell into both. rect is
  // normalized [0,1], so it means nothing until scaled to container percent.
  // And cqw is a fraction of the container's WIDTH only — so a box's HEIGHT has
  // to be converted through the image aspect ratio, or every tall vertical
  // bubble is judged far shorter than it is and the text comes out tiny.
  const aspect = natural.w > 0 ? natural.h / natural.w : 1;
  const wCqw = b.rect.w * 100;
  const hCqw = b.rect.h * 100 * aspect;

  // A box holds about w*h / (1.2*s^2) roughly-square glyphs at size s, with 1.2
  // line spacing. Solve for s at N characters:
  const chars = Math.max(1, b.text.length);
  const ideal = Math.sqrt((wCqw * hCqw) / (1.2 * chars));

  // 0.92 leaves room for padding and imperfect wrapping; the clamp stops a
  // two-word bubble from becoming a poster.
  const fs = Math.max(1.2, Math.min(6, ideal * 0.92));

  const title = b.source ? ` title="${escapeHtml(b.source)}"` : '';
  return `
    <div class="box ${b.direction}"
         style="left:${pct(b.rect.x)}%;top:${pct(b.rect.y)}%;width:${pct(b.rect.w)}%;height:${pct(b.rect.h)}%"${title}>
      <span class="idx">${index + 1}</span>
      <span class="tx" style="font-size:${fs.toFixed(2)}cqw">${escapeHtml(b.text)}</span>
    </div>`;
}

/**
 * Render a run reloaded from storage.
 *
 * No image: the fixtures are not stored, only the numbers and the text. That is
 * deliberate — history is for comparing configurations, and keeping pages of
 * copyrighted manga in localStorage would be both wasteful and wrong.
 */
export function renderStoredRun(root: HTMLElement, run: BenchRun): void {
  root.innerHTML = '';

  for (const page of [...run.pages].reverse()) {
    const t = page.timings;
    const perBlock = summarize(t.perBlock);
    const card = document.createElement('article');
    card.className = 'card restored';
    card.innerHTML = `
      <h2>
        <span>${escapeHtml(page.file)}</span>
        <span class="meta">${page.natural.w}x${page.natural.h} → det ${page.detSize.w}x${page.detSize.h} · ${page.blockCount} blocks</span>
      </h2>
      <div class="card-body">
        <div>
          <div class="side">
            <h3>Timings</h3>
            <table>
              <tr><td>decode + resize</td><td>${fmtMs(t.decode)}</td></tr>
              <tr><td>detect</td><td>${fmtMs(t.detect)}</td></tr>
              <tr><td>group</td><td>${fmtMs(t.group)}</td></tr>
              <tr class="${t.recognize > t.total * 0.6 ? 'hot' : ''}"><td>recognize</td><td>${fmtMs(t.recognize)}</td></tr>
              <tr><td>total</td><td>${fmtMs(t.total)}</td></tr>
              ${perBlock.n > 0 ? `<tr><td>per block (median)</td><td>${fmtMs(perBlock.median)}</td></tr>` : ''}
            </table>
            ${verdict(t.total)}
          </div>
          <div class="side">
            <h3>Text (reading order)</h3>
            <ol class="blocks">
              ${
                page.blocks.length === 0
                  ? '<li class="dir">ไม่พบข้อความ</li>'
                  : page.blocks
                      .map(
                        (b) =>
                          `<li>${escapeHtml(b.text)} <span class="dir">${b.direction}${b.source ? ` · src: ${escapeHtml(b.source)}` : ''}</span></li>`,
                      )
                      .join('')
              }
            </ol>
          </div>
        </div>
      </div>`;
    root.prepend(card);
  }

  renderSummary(root, run.totals);

  const header = document.createElement('article');
  header.className = 'card summary';
  const when = new Date(run.startedAt).toLocaleString();
  header.innerHTML = `
    <h2><span>ผลที่บันทึกไว้</span><span class="meta">${escapeHtml(when)}</span></h2>
    <div class="side">
      <table>
        <tr><td>detector</td><td>${escapeHtml(run.config.detector)}</td></tr>
        <tr><td>recognizer</td><td>${escapeHtml(run.config.recognizer)}</td></tr>
        <tr><td>backend</td><td>${escapeHtml(run.config.backend)}</td></tr>
        <tr><td>preset</td><td>${escapeHtml(run.config.preset)}</td></tr>
        <tr><td>lang</td><td>${escapeHtml(run.config.lang)}</td></tr>
        <tr><td>webgpu</td><td>${run.env.webgpu ? 'available' : 'unavailable'}</td></tr>
      </table>
    </div>`;
  root.prepend(header);
}

export function renderSummary(root: HTMLElement, totals: readonly number[]): void {
  if (totals.length < 2) return;
  const s = summarize(totals);
  const card = document.createElement('article');
  card.className = 'card summary';
  card.innerHTML = `
    <h2><span>สรุป ${s.n} หน้า</span><span class="meta">ค่าที่ใช้ตัดสินคือ median ไม่ใช่ min</span></h2>
    <div class="side">
      <table>
        <tr><td>min</td><td>${fmtMs(s.min)}</td></tr>
        <tr class="hot"><td>median</td><td>${fmtMs(s.median)}</td></tr>
        <tr><td>mean</td><td>${fmtMs(s.mean)}</td></tr>
        <tr><td>max</td><td>${fmtMs(s.max)}</td></tr>
      </table>
      ${verdict(s.median)}
    </div>`;
  root.prepend(card);
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
