import type { BenchRun } from '../bench/store';
import { fmtMs, summarize } from '../bench/timer';
import { placePanels, type PlacedPanel } from '../core/panel-layout';
import { panelRect, plateAlphaOver, plateInPanel } from '../core/panel-shape';
import type { GroupingReport, HarnessBlock, HarnessResult } from '../pipeline';

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
  result: HarnessResult,
): void {
  const { timings: t, blocks } = result;
  const perBlock = summarize(t.perBlock);
  const card = document.createElement('article');
  card.className = 'card';

  // Exactly what the extension draws: the detected box widened into a panel the
  // Thai can be set across, then pushed off its neighbours. Same two modules,
  // same order, same numbers — so a page that looks wrong here looks wrong
  // there, which is the only reason this harness is worth running.
  const aspect = result.natural.w > 0 ? result.natural.h / result.natural.w : 1;
  const placed = placePanels(
    blocks.map((b) => ({ anchor: b.rect, panel: panelRect(b.rect, b.direction, aspect) })),
    aspect,
  );

  const boxes = blocks.map((b, i) => renderBox(b, placed[i]!, i, aspect)).join('');

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
                      (b, i) =>
                        `<li>${escapeHtml(b.text)} <span class="dir">${b.direction}${b.parts > 1 ? ` · รวม ${b.parts} กล่อง` : ''}${placed[i]?.trimmed ? ' · หด' : ''}${placed[i]?.crowded ? ' · ซ้อน' : ''}${b.score < 0.7 ? ` · low ${b.score.toFixed(2)}` : ''}</span></li>`,
                    )
                    .join('')
            }
          </ol>
        </div>
        ${renderGrouping(result.grouping, placed)}
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
 * One overlay panel, with the translated text laid into it.
 *
 * This is the extension's overlay strategy rehearsed early: geometry in
 * percentages so it survives any rendered size, and font size in `cqw` so the
 * text scales with the image instead of needing JS on resize. If this breaks
 * when the window is dragged, better to find out in the harness than in M2.
 *
 * Two rectangles, as in the extension. The **panel** is where the Thai is set,
 * widened for vertical source text because a three-percent-wide column would
 * otherwise wrap Thai to one glyph per line. The **plate** is the detected box
 * itself, drawn opaque inside the panel, because that is the only part that has
 * to hide anything.
 */
/**
 * Harness stand-ins for `display.boxOpacity` and the panel opacity beside it.
 *
 * Fixed here rather than wired to a control: the harness is checking geometry,
 * and two more sliders would only make it harder to tell a layout bug from a
 * setting.
 */
const PANEL_OPACITY = 0.55;
const PLATE_OPACITY = 0.94;

function renderBox(
  b: HarnessBlock,
  placed: PlacedPanel,
  index: number,
  aspect: number,
): string {
  const pct = (v: number) => (v * 100).toFixed(3);
  const panel = placed.rect;

  // Font size in cqw, from how much text actually has to fit.
  //
  // Two unit traps live here, and the first version fell into both. rect is
  // normalized [0,1], so it means nothing until scaled to container percent.
  // And cqw is a fraction of the container's WIDTH only — so a box's HEIGHT has
  // to be converted through the image aspect ratio, or every tall vertical
  // bubble is judged far shorter than it is and the text comes out tiny.
  const wCqw = panel.w * 100;
  const hCqw = panel.h * 100 * aspect;

  // A box holds about w*h / (1.2*s^2) roughly-square glyphs at size s, with 1.2
  // line spacing. Solve for s at N characters:
  const chars = Math.max(1, b.text.length);
  const ideal = Math.sqrt((wCqw * hCqw) / (1.2 * chars));

  // 0.92 leaves room for padding and imperfect wrapping; the clamp stops a
  // two-word bubble from becoming a poster.
  const fs = Math.max(1.2, Math.min(6, ideal * 0.92));

  const plate = plateInPanel(b.rect, panel);
  // The plate sits *inside* the panel, so painting both at their nominal values
  // would composite darker than either asked for. `plateAlphaOver` returns the
  // alpha that makes the stack come out at max(plate, panel) — and 0, meaning
  // "do not draw it at all", when the panel already covers everything the plate
  // would. Exercised here so the harness shows the same greys the reader sees.
  const plateAlpha = plateAlphaOver(PLATE_OPACITY, PANEL_OPACITY);
  const flags = [
    b.parts > 1 ? 'merged' : '',
    placed.trimmed ? 'trimmed' : '',
    placed.crowded ? 'crowded' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const title = b.source ? ` title="${escapeHtml(b.source)}"` : '';
  return `
    <div class="box ${b.direction} ${flags}"
         style="left:${pct(panel.x)}%;top:${pct(panel.y)}%;width:${pct(panel.w)}%;height:${pct(panel.h)}%;background:rgba(255,255,255,${PANEL_OPACITY})"${title}>
      ${
        plateAlpha > 0
          ? `<span class="plate" style="left:${pct(plate.x)}%;top:${pct(plate.y)}%;width:${pct(plate.w)}%;height:${pct(plate.h)}%;background:rgba(255,255,255,${plateAlpha.toFixed(3)})"></span>`
          : ''
      }
      <span class="idx">${index + 1}${b.parts > 1 ? ` ×${b.parts}` : ''}</span>
      <span class="tx" style="font-size:${fs.toFixed(2)}cqw">${escapeHtml(b.text)}</span>
    </div>`;
}

const REJECTION_TH: Record<string, string> = {
  'too-few': 'ไม่ถึง 2 กล่อง',
  'too-many': 'มากเกินไป',
  'bad-index': 'id ไม่มีอยู่จริง',
  'already-merged': 'กล่องถูกรวมไปแล้ว',
  'mixed-direction': 'คนละแนว',
  'glyph-mismatch': 'ขนาดตัวอักษรต่างกัน',
  'not-a-fragment': 'เป็น bubble เต็มๆ ไม่ใช่เศษ',
  'not-adjacent': 'อยู่ไกลกันเกินไป',
  'union-too-large': 'กล่องรวมใหญ่เกิน',
};

/**
 * What the model asked for and what geometry did about it.
 *
 * The point of showing the rejections, not just the merges: a veto that fires on
 * every ordinary page is the difference between "the model is being sensible"
 * and "the limits are wrong", and there is no way to tell those apart from the
 * picture alone.
 */
function renderGrouping(report: GroupingReport, placed: readonly PlacedPanel[]): string {
  const crowded = placed.filter((p) => p.crowded).length;
  const trimmed = placed.filter((p) => p.trimmed).length;
  const quiet =
    report.accepted.length === 0 && report.rejected.length === 0 && crowded === 0 && trimmed === 0;

  return `
    <div class="side">
      <h3>Grouping &amp; layout</h3>
      <table>
        <tr><td>กล่องที่ตรวจเจอ</td><td>${report.before}</td></tr>
        <tr class="${report.after !== report.before ? 'hot' : ''}"><td>กล่องที่วาดจริง</td><td>${report.after}</td></tr>
        <tr><td>โมเดลขอรวม</td><td>${report.accepted.length + report.rejected.length}</td></tr>
        <tr><td>รวมให้ / ปฏิเสธ</td><td>${report.accepted.length} / ${report.rejected.length}</td></tr>
        <tr><td>ถูกหดเพราะชนกัน</td><td>${trimmed}</td></tr>
        <tr class="${crowded > 0 ? 'hot' : ''}"><td>ยังซ้อนกันอยู่</td><td>${crowded}</td></tr>
      </table>
      ${quiet ? '<p class="dir">หน้านี้ไม่มีอะไรถูกรวมและไม่มีอะไรชนกัน — คือผลลัพธ์ปกติ</p>' : ''}
      ${
        report.accepted.length > 0
          ? `<ol class="blocks">${report.accepted
              .map(
                (a) =>
                  `<li>✅ รวม ${a.blocks.map((b) => b + 1).join('+')} → ${escapeHtml(a.out || a.src)}</li>`,
              )
              .join('')}</ol>`
          : ''
      }
      ${
        report.rejected.length > 0
          ? `<ol class="blocks">${report.rejected
              .map(
                (r) =>
                  `<li>🚫 ${r.blocks.map((b) => b + 1).join('+')} <span class="dir">${REJECTION_TH[r.reason] ?? r.reason}</span></li>`,
              )
              .join('')}</ol>`
          : ''
      }
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
        <tr><td>dilate / nms</td><td>${run.config.dilate ?? '?'} / ${run.config.nms ?? '?'}</td></tr>
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
