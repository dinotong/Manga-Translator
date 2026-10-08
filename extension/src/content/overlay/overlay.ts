import { computeContentBox } from '../../core/geometry';
import type { OverlayBlock } from '../../shared/messages';
import type { Settings } from '../../shared/settings';
import type { NormRect, Size } from '../../types';
import { OVERLAY_CSS } from './styles';
import { placePanels, settlePanels } from '../../core/panel-layout';
import { fitFont, plateFromCentre } from '../../core/font-fit';
import { joinLayoutBreaks } from '../../core/reflow';
import { inkRect, panelRect, plateAlphaOver } from '../../core/panel-shape';

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
  /** What `placePanels` chose, before the browser laid any text out. */
  panels: NormRect[];
  /** The detected blocks, which each panel must keep covering. */
  anchors: NormRect[];
  aspect: number;
  /** Layer width the boxes were last measured at; 0 until the first time. */
  settledW: number;
}

export class Overlay {
  /** Null until the first thing is actually drawn — see `root`. */
  private shadow: ShadowRoot | null = null;
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
  }

  /**
   * The shadow root, created the first time something is drawn.
   *
   * The content script runs on every page in the browser, but auto-translate is
   * per-site and most sites are off. Building this in the constructor put a
   * custom element into every document, added six global listeners to it, and —
   * the part that actually costs something — started a requestAnimationFrame
   * loop that never stops, on tabs that were never going to translate anything.
   * Deferring it means a page nobody opted in gets no DOM node and no frame
   * callbacks at all, while the first `attach`/`status` sets everything up
   * exactly as before.
   */
  private get root(): ShadowRoot {
    return this.shadow ?? this.mount();
  }

  private mount(): ShadowRoot {
    const host = document.createElement('manga-translator-root');
    // Closed: nothing on the page should be able to reach in and restyle or
    // scrape our nodes, and we never need to reach in from outside either.
    const shadow = host.attachShadow({ mode: 'closed' });
    this.shadow = shadow;
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    shadow.append(style);
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
    return shadow;
  }

  /**
   * Adopt new settings and redraw what is already on screen.
   *
   * Redrawn, never cleared: everything here is presentation — font size, how
   * opaque each layer is — and a re-translate would spend a request from a
   * 1,000/day budget to arrive at the same words.
   *
   * The snapshot is not tidiness. `attach` deletes the entry and puts it back,
   * and a Map re-insertion lands *behind* a live iterator, which then reaches it
   * again and repeats — forever. That was a hang of the page's main thread on
   * every settings change, with no way out but closing the tab, and it is the
   * reason changing a setting appeared to break every open reader.
   */
  updateSettings(settings: Settings): void {
    this.settings = settings;
    for (const { hash, target } of Array.from(this.mounted.values())) this.attach(target, hash);
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
    const aspect = result.natural.w > 0 ? result.natural.h / result.natural.w : 1;
    // Widen each block into a panel the target language can be set across, then
    // push the panels off each other. Nothing did the second part before, and
    // widening is exactly what makes it necessary: two neighbouring columns
    // whose panels overlap leave both texts unreadable. `placePanels` slides
    // where there is room and gives width back where there is not, and never
    // uncovers the ink it is there to hide — see core/panel-layout.ts. On
    // ordinary pages it changes nothing at all.
    // What has to stay covered is the ink, which reaches a little past the
    // detected box — see `inkRect`.
    const inks = result.blocks.map((b) => inkRect(b.rect, aspect));
    const panels = placePanels(
      result.blocks.map((b, i) => ({
        anchor: inks[i]!,
        panel: panelRect(inks[i]!, b.direction, aspect),
      })),
      aspect,
    ).map((p) => p.rect);

    const layer = document.createElement('div');
    layer.className = 'mt-layer';
    layer.dataset.hash = hash;
    layer.innerHTML = result.blocks
      .map((b, i) => this.renderBox(b, inks[i]!, panels[i] ?? inks[i]!, aspect))
      .join('');

    this.root.append(layer);
    this.mounted.set(target, {
      hash,
      layer,
      target,
      boxes: Array.from(layer.children) as HTMLElement[],
      // The panel, not the detected block: this is what hover hit-tests against,
      // and the reader can only aim at what they can see. A widened panel whose
      // hover region was still the narrow column meant pointing at the part of
      // the box that covers the art — the part they want out of the way — did
      // nothing.
      rects: panels.slice(),
      placement: null,
      panels,
      anchors: inks,
      aspect,
      settledW: 0,
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
        // The pixel floor makes rendered size depend on rendered width, so the
        // boxes are measured again whenever the layer changes width — and only
        // then, since measuring forces a layout.
        if (m.placement.w > 0 && Math.abs(m.placement.w - m.settledW) > 0.5) this.settle(m);
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

  /**
   * Move each box off its neighbours now that its real size is known.
   *
   * `placePanels` placed the panels at the size `panelRect` asked for; the
   * pixel floor, a panel widened to its longest word and `min-height: max-content` can all grow
   * a box past that, about its centre and into the next one. See `settlePanels`.
   */
  private settle(m: Mounted): void {
    const p = m.placement;
    if (!p || p.w <= 0 || p.h <= 0) return;
    m.settledW = p.w;
    const sizes = m.boxes.map((b) => ({ w: b.offsetWidth / p.w, h: b.offsetHeight / p.h }));
    const centres = settlePanels(
      m.panels.map((panel, i) => ({ panel, anchor: m.anchors[i] ?? panel, size: sizes[i]! })),
      m.aspect,
    );
    const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
    centres.forEach((c, i) => {
      const box = m.boxes[i];
      const panel = m.panels[i];
      if (!box || !panel) return;
      box.style.left = pct(c.cx);
      box.style.top = pct(c.cy);
      // The plate hangs off the box's centre, so a box that moved would carry
      // it off the ink. Re-measure it from the new centre.
      const plate = box.querySelector<HTMLElement>('.mt-plate');
      const anchor = m.anchors[i];
      if (plate && anchor) {
        const moved = { ...panel, x: c.cx - panel.w / 2, y: c.cy - panel.h / 2 };
        const off = plateFromCentre(anchor, moved, m.aspect);
        plate.style.left = `calc(50% + ${off.dx.toFixed(3)}cqw)`;
        plate.style.top = `calc(50% + ${off.dy.toFixed(3)}cqw)`;
      }
      const w = Math.max(panel.w, sizes[i]!.w);
      const h = Math.max(panel.h, sizes[i]!.h);
      m.rects[i] = { x: c.cx - w / 2, y: c.cy - h / 2, w, h };
    });
  }

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
   * One bubble: the text panel, with the cover plate nested inside it.
   *
   * Nested rather than side by side so that one bubble stays one element as far
   * as everything else is concerned — hover, peeking, hit-testing and the
   * `boxes`/`rects` pairing all address the panel and the plate follows it. The
   * plate is positioned from the panel's centre, which is what `plateFromCentre`
   * converts to.
   *
   * Font size is computed here rather than by CSS because it depends on how much
   * text has to fit — see core/font-fit.ts. The panel is positioned by its
   * centre so that, when the pixel floor wins over the area-based size, it grows
   * evenly in every direction instead of only to the right and down.
   */
  private renderBox(b: OverlayBlock, ink: NormRect, panel: NormRect, aspect: number): string {
    const pct = (v: number) => (v * 100).toFixed(3);
    // Also here, not only where replies are read: translations cached before
    // the reply path learned to join them still carry the model's line breaks.
    const text = joinLayoutBreaks(b.text);
    const fit = fitFont(panel, aspect, text, this.settings.display.fontScale);

    const hover = this.settings.display.mode === 'target-plus-source-on-hover' && b.source;
    const style =
      `left:${pct(panel.x + panel.w / 2)}%;top:${pct(panel.y + panel.h / 2)}%;` +
      `width:${pct(panel.w)}%;height:${pct(panel.h)}%;` +
      `font-size:max(${fit.cqw.toFixed(2)}cqw,${fit.minPx.toFixed(1)}px);` +
      `--mt-panel-opacity:${this.settings.display.panelOpacity}`;
    const cls = `mt-box${b.refused ? ' refused' : ''}`;

    return (
      `<div class="${cls}" style="${style}"${hover ? ' data-hover="1"' : ''}>` +
      this.renderPlate(b, ink, panel, aspect) +
      `<span class="mt-text">${escapeHtml(text)}</span>` +
      (hover ? `<span class="mt-src">${escapeHtml(b.source)}</span>` : '') +
      '</div>'
    );
  }

  /**
   * The cover plate, or nothing.
   *
   * Nothing in two cases. A refused block has no translation to put in the
   * source's place, so hiding it would cost the reader the only text there is —
   * the dashed marker sits over the Japanese and lets it show. And a plate that
   * would add no opacity over the panel is not drawn at all, which is what stops
   * the coincident case (horizontal text, panel not widened) from stacking two
   * elements and coming out darker than either setting asked for.
   */
  private renderPlate(b: OverlayBlock, ink: NormRect, panel: NormRect, aspect: number): string {
    if (b.refused) return '';
    const alpha = plateAlphaOver(
      this.settings.display.plateOpacity,
      this.settings.display.panelOpacity,
    );
    if (alpha <= 0) return '';

    // Offsets from the panel centre in cqw, not percentages of the panel: the
    // panel may grow to fit its text, and the plate must stay on the ink.
    const p = plateFromCentre(ink, panel, aspect);
    const n = (v: number) => v.toFixed(3);
    return (
      `<i class="mt-plate" style="left:calc(50% + ${n(p.dx)}cqw);top:calc(50% + ${n(p.dy)}cqw);` +
      `width:${n(p.w)}cqw;height:${n(p.h)}cqw;--mt-plate-alpha:${alpha.toFixed(4)}"></i>`
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
