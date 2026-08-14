import { computeContentBox } from '../../core/geometry';
import type { OverlayBlock } from '../../shared/messages';
import type { Settings } from '../../shared/settings';
import type { Size } from '../../types';
import { OVERLAY_CSS } from './styles';

/**
 * The overlay layer.
 *
 * Two rules shape everything here.
 *
 * First: the site's DOM is never touched. No wrapper divs, no position changes,
 * no children injected into the page's elements — a React reader would re-render
 * over any of that, or break its own layout because of it. Everything lives in
 * one closed shadow root hanging off document.body.
 *
 * Second: results are keyed by image hash, never by element. imhentai runs a
 * whole gallery through a single `<img id="gimg">` and swaps its src, so an
 * element-keyed overlay leaves page 3's translation sitting on top of page 4 —
 * a failure worse than showing nothing, because the reader has no way to notice.
 */

interface Mounted {
  hash: string;
  layer: HTMLDivElement;
  target: HTMLImageElement;
}

export class Overlay {
  private readonly root: ShadowRoot;
  /** Results by image hash, so a re-shown page mounts instantly. */
  private readonly results = new Map<string, { natural: Size; blocks: OverlayBlock[] }>();
  private readonly mounted = new Map<HTMLImageElement, Mounted>();
  private readonly statuses = new Map<HTMLImageElement, HTMLDivElement>();
  private dirty = true;
  private settings: Settings;

  constructor(settings: Settings) {
    this.settings = settings;

    const host = document.createElement('manga-translator-root');
    // Closed: nothing on the page should be able to reach in and restyle or
    // scrape our nodes, and we never need to reach in from outside either.
    this.root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    this.root.append(style);
    document.body.append(host);

    const markDirty = () => {
      this.dirty = true;
    };
    // capture:true so scrolling inside a reader's own scroll container counts.
    addEventListener('scroll', markDirty, { passive: true, capture: true });
    addEventListener('resize', markDirty, { passive: true });
    requestAnimationFrame(this.tick);
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
    for (const { hash, target } of this.mounted.values()) this.attach(target, hash);
  }

  /** Cache a finished result under its hash. Does not display it. */
  setResult(hash: string, natural: Size, blocks: OverlayBlock[]): void {
    this.results.set(hash, { natural, blocks });
  }

  has(hash: string): boolean {
    return this.results.has(hash);
  }

  /** Show the result for `hash` on `target`, replacing whatever was there. */
  attach(target: HTMLImageElement, hash: string): boolean {
    const result = this.results.get(hash);
    if (!result) return false;

    this.detach(target);
    const layer = document.createElement('div');
    layer.className = 'mt-layer';
    layer.dataset.hash = hash;
    layer.innerHTML = result.blocks
      .map((b) => this.renderBox(b, result.natural))
      .join('');

    this.root.append(layer);
    this.mounted.set(target, { hash, layer, target });
    this.dirty = true;
    return true;
  }

  detach(target: HTMLImageElement): void {
    this.mounted.get(target)?.layer.remove();
    this.mounted.delete(target);
  }

  /**
   * Drop the overlay for an element the instant its src changes.
   *
   * Not "when the new result arrives" — between those two moments the old
   * translation would be sitting on a different page.
   */
  invalidate(target: HTMLImageElement): void {
    this.detach(target);
  }

  clearAll(): void {
    for (const target of Array.from(this.mounted.keys())) this.detach(target);
    for (const el of this.statuses.values()) el.remove();
    this.statuses.clear();
  }

  status(target: HTMLImageElement, text: string, kind: 'info' | 'error' = 'info'): void {
    if (!text) {
      this.statuses.get(target)?.remove();
      this.statuses.delete(target);
      return;
    }
    let el = this.statuses.get(target);
    if (!el) {
      el = document.createElement('div');
      this.root.append(el);
      this.statuses.set(target, el);
    }
    el.className = kind === 'error' ? 'mt-status err' : 'mt-status';
    el.textContent = text;
    this.dirty = true;
  }

  /**
   * Reposition mounted layers onto their images.
   *
   * Runs only when something marked the frame dirty, reads at most a handful of
   * rects, and writes `transform` rather than left/top so the compositor handles
   * it without a layout pass.
   */
  private readonly tick = (): void => {
    if (this.dirty) {
      this.dirty = false;
      for (const [target, m] of this.mounted) {
        if (!target.isConnected) {
          this.detach(target);
          continue;
        }
        place(m.layer, target);
      }
      for (const [target, el] of this.statuses) {
        if (!target.isConnected) {
          el.remove();
          this.statuses.delete(target);
          continue;
        }
        place(el, target, true);
      }
    }
    requestAnimationFrame(this.tick);
  };

  /**
   * One box.
   *
   * Font size is computed here rather than by CSS because it depends on how much
   * text has to fit. Two unit traps live in this calculation: rect is normalized
   * [0,1] and means nothing until scaled to container percent, and `cqw` is a
   * fraction of the container's WIDTH only — so a box's height must be converted
   * through the image's aspect ratio or every tall vertical bubble is judged far
   * shorter than it is and its text comes out tiny.
   */
  private renderBox(b: OverlayBlock, natural: Size): string {
    const pct = (v: number) => (v * 100).toFixed(3);
    const aspect = natural.w > 0 ? natural.h / natural.w : 1;
    const wCqw = b.rect.w * 100;
    const hCqw = b.rect.h * 100 * aspect;

    // A box holds about w*h / (1.2*s^2) roughly-square glyphs at size s with 1.2
    // line spacing. Solve for s at N characters.
    const chars = Math.max(1, b.text.length);
    const ideal = Math.sqrt((wCqw * hCqw) / (1.2 * chars));
    // 0.92 leaves room for padding and imperfect wrapping; the clamp stops a
    // two-word bubble from becoming a poster.
    const fs = Math.max(1.2, Math.min(6, ideal * 0.92)) * this.settings.display.fontScale;

    const hover = this.settings.display.mode === 'target-plus-source-on-hover' && b.source;
    const style =
      `left:${pct(b.rect.x)}%;top:${pct(b.rect.y)}%;` +
      `width:${pct(b.rect.w)}%;height:${pct(b.rect.h)}%;` +
      `font-size:${fs.toFixed(2)}cqw;` +
      `--mt-box-opacity:${this.settings.display.boxOpacity}`;

    return (
      `<div class="mt-box${b.refused ? ' refused' : ''}" style="${style}"${hover ? ' data-hover="1"' : ''}>` +
      `<span class="mt-text">${escapeHtml(b.text)}</span>` +
      (hover ? `<span class="mt-src">${escapeHtml(b.source)}</span>` : '') +
      '</div>'
    );
  }
}

/**
 * Put an absolutely-positioned element exactly over an image's *pixels*.
 *
 * Not over its box: MangaDex renders a 3496x4960 page into a 507x720 element
 * with `object-fit: contain`, so trusting getBoundingClientRect would shift
 * every bubble by the size of the letterbox bars.
 */
function place(el: HTMLElement, target: HTMLImageElement, corner = false): void {
  const rect = target.getBoundingClientRect();
  const fit = getComputedStyle(target).objectFit;
  const content = computeContentBox(
    { w: rect.width, h: rect.height },
    { w: target.naturalWidth, h: target.naturalHeight },
    fit === 'cover' ? 'cover' : fit === 'fill' ? 'fill' : 'contain',
  );

  // The status pill is nudged inside the top-left corner rather than sized to
  // the image, so it stays readable on a page that is 40px wide in a preload
  // slot.
  const x = rect.left + scrollX + content.x + (corner ? 8 : 0);
  const y = rect.top + scrollY + content.y + (corner ? 8 : 0);
  el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  if (!corner) {
    el.style.width = `${content.w.toFixed(1)}px`;
    el.style.height = `${content.h.toFixed(1)}px`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
