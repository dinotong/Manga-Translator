import { computeContentBox } from '../../core/geometry';
import type { OverlayBlock } from '../../shared/messages';
import type { Settings } from '../../shared/settings';
import type { NormRect, Size } from '../../types';
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

/** Where a layer currently sits, in page coordinates. */
interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Mounted {
  hash: string;
  layer: HTMLDivElement;
  target: HTMLImageElement;
  /** The box elements, in the order they were rendered and painted. */
  boxes: HTMLElement[];
  /** Their normalized rects, so hover hit-testing needs no DOM reads at all. */
  rects: NormRect[];
  placement: Placement | null;
}

export class Overlay {
  private readonly root: ShadowRoot;
  /** Results by image hash, so a re-shown page mounts instantly. */
  private readonly results = new Map<string, { natural: Size; blocks: OverlayBlock[] }>();
  private readonly mounted = new Map<HTMLImageElement, Mounted>();
  private readonly statuses = new Map<HTMLImageElement, HTMLDivElement>();
  /**
   * Elements whose size we are following.
   *
   * A paged reader can resize an image without a scroll or a window resize:
   * MangaDex keeps every page of the chapter in the DOM and turns a page by
   * collapsing one to 0x0 and expanding the next. Without this, a page that was
   * translated while it sat in the preload slot would keep its overlay at zero
   * size after it became the page on screen.
   */
  private readonly observed = new Set<HTMLImageElement>();
  private readonly ro = new ResizeObserver(() => {
    this.dirty = true;
  });
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

    // Hover is watched, not received.
    //
    // The layer cannot take pointer events without stealing the click that
    // turns the page, so the pointer's position is observed on the way past and
    // the box under it is worked out arithmetically. `passive` and `capture`
    // mean a site that stops propagation, or calls preventDefault, changes
    // nothing about what we see, and we never affect its own handlers.
    addEventListener('pointermove', this.onPointerMove, { passive: true, capture: true });
    addEventListener('pointerdown', this.onPointerMove, { passive: true, capture: true });
    // Leaving the window has no pointermove of its own, and a panel left faded
    // after the mouse is gone looks like a rendering bug.
    document.addEventListener('pointerleave', this.onPointerOut, { capture: true });
    addEventListener('blur', this.onPointerOut);

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
    this.mounted.set(target, {
      hash,
      layer,
      target,
      boxes: Array.from(layer.children) as HTMLElement[],
      rects: result.blocks.map((b) => b.rect),
      placement: null,
    });
    this.track(target);
    this.dirty = true;
    return true;
  }

  detach(target: HTMLImageElement): void {
    this.mounted.get(target)?.layer.remove();
    this.mounted.delete(target);
    // The faded box may have just been removed from the document along with its
    // layer; holding the reference would leave hover stuck on a dead node.
    if (this.hovered && !this.hovered.isConnected) this.hovered = null;
    this.untrack(target);
  }

  /** Every element currently showing a translation. */
  mountedTargets(): HTMLImageElement[] {
    return Array.from(this.mounted.keys());
  }

  /** The hash currently drawn on an element, if any. */
  hashOn(target: HTMLImageElement): string | undefined {
    return this.mounted.get(target)?.hash;
  }

  private track(target: HTMLImageElement): void {
    if (this.observed.has(target)) return;
    this.observed.add(target);
    this.ro.observe(target);
  }

  private untrack(target: HTMLImageElement): void {
    if (this.mounted.has(target) || this.statuses.has(target)) return;
    if (!this.observed.delete(target)) return;
    this.ro.unobserve(target);
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
      this.untrack(target);
      return;
    }
    let el = this.statuses.get(target);
    if (!el) {
      el = document.createElement('div');
      this.root.append(el);
      this.statuses.set(target, el);
      this.track(target);
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
        m.placement = place(m.layer, target);
      }
      for (const [target, el] of this.statuses) {
        if (!target.isConnected) {
          el.remove();
          this.statuses.delete(target);
          this.untrack(target);
          continue;
        }
        place(el, target, true);
      }
      // Everything moved, so what the pointer is over may have changed even
      // though it did not move — scrolling with the wheel, or a page turn while
      // the mouse rests on a bubble.
      this.resolveHover();
    }
    requestAnimationFrame(this.tick);
  };

  /* ---------------- hover, without taking the pointer ---------------- */

  /** The box currently faded and/or showing its source. At most one. */
  private hovered: HTMLElement | null = null;
  /** Last seen pointer position, in page coordinates. */
  private pointer: { x: number; y: number } | null = null;

  private readonly onPointerMove = (ev: PointerEvent): void => {
    this.pointer = { x: ev.clientX + scrollX, y: ev.clientY + scrollY };
    this.resolveHover();
  };

  private readonly onPointerOut = (): void => {
    this.pointer = null;
    this.setHovered(null);
  };

  /** Does any setting actually want to know where the pointer is? */
  private hoverWanted(): boolean {
    return (
      this.settings.display.peekOnHover ||
      this.settings.display.mode === 'target-plus-source-on-hover'
    );
  }

  private resolveHover(): void {
    if (!this.hoverWanted() || this.mounted.size === 0) return this.setHovered(null);
    const p = this.pointer;
    this.setHovered(p ? this.boxAt(p.x, p.y) : null);
  }

  /**
   * Which box is under a page-space point.
   *
   * Pure arithmetic over cached geometry: no getBoundingClientRect, no
   * elementFromPoint — which would not work anyway, since it honours
   * `pointer-events: none` and would look straight through the layer.
   *
   * Ties go to whatever paints on top, which is the last matching box of the
   * last mounted layer. That is the box the reader sees under the cursor, so
   * that is the one that gets out of the way; the others stay put.
   */
  private boxAt(x: number, y: number): HTMLElement | null {
    let hit: HTMLElement | null = null;
    // Map iteration is insertion order, and later layers paint above earlier
    // ones, so the last match wins. Iterating forward and keeping the last one
    // avoids allocating a reversed copy on every pointer move.
    for (const m of this.mounted.values()) {
      const p = m.placement;
      if (!p || p.w <= 0 || p.h <= 0) continue;
      if (x < p.x || x > p.x + p.w || y < p.y || y > p.y + p.h) continue;

      for (let i = 0; i < m.rects.length; i++) {
        const r = m.rects[i];
        const box = m.boxes[i];
        if (!r || !box) continue;
        const bx = p.x + r.x * p.w;
        const by = p.y + r.y * p.h;
        if (x >= bx && x <= bx + r.w * p.w && y >= by && y <= by + r.h * p.h) hit = box;
      }
    }
    return hit;
  }

  private setHovered(next: HTMLElement | null): void {
    if (next === this.hovered) return;
    this.hovered?.classList.remove('peek', 'src');
    this.hovered = next;
    if (!next) return;
    if (this.settings.display.peekOnHover) next.classList.add('peek');
    // Only set on boxes that actually have source text to show.
    if (next.dataset.hover === '1') next.classList.add('src');
  }

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
function place(el: HTMLElement, target: HTMLImageElement, corner = false): Placement {
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
  return { x, y, w: content.w, h: content.h };
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
