import type { NormRect } from '../types';

/**
 * Keeping two translated panels off each other.
 *
 * Nothing did this before. Detected blocks can already overlap — a sound effect
 * crossing a bubble, two bounding boxes drawn round interleaved columns — and
 * `panelRect` then widens every vertical block outwards from its centre, which
 * turns "nearly touching" into "on top of each other" on any page with columns
 * close together. Two panels sharing pixels is the one failure a reader cannot
 * work around: neither text is legible and there is no way to tell which words
 * belong to which bubble.
 *
 * ## What this guarantees
 *
 * > **The output never overlaps anywhere the detected boxes did not already
 * > overlap.**
 *
 * That holds because every panel keeps covering its own anchor (the detected
 * box, where the ink is) and is always allowed to shrink back to exactly that
 * anchor. So if the anchors are disjoint, "everything at its anchor" is a valid
 * answer and the search can always reach it; the algorithm below only ever stops
 * somewhere better. Where the anchors themselves overlap, no arrangement of
 * rectangles that covers all the ink can be disjoint, and the panel is marked
 * `crowded` rather than quietly uncovering Japanese text.
 *
 * ## How
 *
 * Panels are placed one at a time in input order — which is reading order by the
 * time this is called, so when something has to give it is the later bubble that
 * gives. Each panel must avoid:
 *
 *   - the *final* rects of the panels placed before it, and
 *   - the *anchors* of the panels not placed yet.
 *
 * Avoiding later anchors rather than later panels is what makes the guarantee
 * provable: an anchor is fixed, so a panel placed early can never be invalidated
 * by a decision made later, and no second pass is needed.
 *
 * Two moves are available, and the order between them is the whole design:
 *
 *   1. **Slide** — move the panel without resizing it. Costs nothing that the
 *      reader can see, because the panel still covers its own ink. This is what
 *      turns two columns whose widened panels collide into two full-width panels
 *      side by side, which is the common case and the one worth getting right.
 *   2. **Trim** — give back some of the width `panelRect` bought. Only when no
 *      slide clears the obstacle. The text gets less room, but it is still the
 *      right text in the right place.
 *
 * A slide is always preferred, and the shortest one is taken; the shortest slide
 * is exactly the penetration depth, so preferring slides cannot send a panel
 * wandering. Neither move may uncover the anchor, which bounds a slide to the
 * width the panel gained in the first place.
 */

/** One panel and the ink it exists to cover. */
export interface PanelPlacement {
  /** What `panelRect` asked for. */
  panel: NormRect;
  /** The detected block. A panel must never stop covering this. */
  anchor: NormRect;
}

export interface PlacedPanel {
  rect: NormRect;
  /** Smaller than the panel asked for: some of the widening had to be given back. */
  trimmed: boolean;
  /** Not on top of anything by choice — the detected boxes themselves overlap here. */
  crowded: boolean;
}

/**
 * A slide can send a panel into a different obstacle, which can send it back.
 * The visited-state check below makes a true cycle impossible, so this is only a
 * ceiling on work, not on correctness — running out of passes falls back to the
 * anchor, which is always safe.
 */
const MAX_PASSES = 12;

/** Below this, an overlap is a rounding artefact rather than a shared pixel. */
const EPS = 1e-6;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * @param items  panels in reading order, each with the block it covers
 * @param aspect natural.h / natural.w — needed because a normalized width and a
 *               normalized height are not the same length (see types.ts). Every
 *               comparison below happens with y scaled into width's units.
 */
export function placePanels(
  items: readonly PanelPlacement[],
  aspect: number,
): PlacedPanel[] {
  const k = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  if (items.length === 0) return [];

  const wanted = items.map((i) => toSquare(i.panel, k));
  const anchors = items.map((i) => toSquare(i.anchor, k));
  const placed: Rect[] = [];

  for (let i = 0; i < items.length; i++) {
    const anchor = anchors[i]!;
    const obstacles: Rect[] = [];
    for (let j = 0; j < i; j++) obstacles.push(placed[j]!);
    for (let j = i + 1; j < items.length; j++) obstacles.push(anchors[j]!);

    placed.push(place(wanted[i]!, anchor, obstacles, k));
  }

  return placed.map((rect, i) => {
    const want = wanted[i]!;
    // `crowded` is judged against the *final* rects of everything else, not the
    // mixture of finals and anchors used while placing: it is a statement about
    // the page as the reader will see it.
    const others = placed.filter((_, j) => j !== i);
    return {
      rect: fromSquare(rect, k),
      trimmed: rect.w < want.w - EPS || rect.h < want.h - EPS,
      crowded: worstOverlap(rect, others) !== null,
    };
  });
}

function place(want: Rect, anchor: Rect, obstacles: readonly Rect[], aspect: number): Rect {
  let rect = { ...want };
  const seen = new Set<string>([key(rect)]);

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const worst = worstOverlap(rect, obstacles);
    if (!worst) return rect;

    const next = escape(rect, anchor, worst, aspect, seen);
    if (!next) break;
    seen.add(key(next));
    rect = next;
  }

  if (!worstOverlap(rect, obstacles)) return rect;

  // Nowhere left to go. The anchor is the smallest honest answer: it still
  // covers every pixel of Japanese this panel is responsible for hiding, and it
  // is the arrangement the extension had before panels were widened at all.
  // Only in the crowded case — overlapping anchors — can it fail to clear the
  // obstacles too, and then the lesser of the two evils wins.
  const fallback = { ...anchor };
  return totalOverlap(fallback, obstacles) <= totalOverlap(rect, obstacles) ? fallback : rect;
}

function totalOverlap(rect: Rect, obstacles: readonly Rect[]): number {
  return obstacles.reduce((sum, o) => sum + overlapArea(rect, o), 0);
}

/**
 * The one obstacle to deal with next: the one sharing the most area.
 *
 * Largest first rather than in list order, because clearing the worst offender
 * often clears the small ones with it, and because it makes the result
 * independent of how the obstacle list happened to be built.
 */
function worstOverlap(rect: Rect, obstacles: readonly Rect[]): Rect | null {
  let best: Rect | null = null;
  let bestArea = EPS;
  for (const o of obstacles) {
    const a = overlapArea(rect, o);
    if (a > bestArea) {
      bestArea = a;
      best = o;
    }
  }
  return best;
}

interface Move {
  rect: Rect;
  /** Slides sort before trims regardless of the numbers. */
  kind: 0 | 1;
  cost: number;
}

/** Every legal way out of one obstacle, cheapest first, minus anything already tried. */
function escape(
  rect: Rect,
  anchor: Rect,
  o: Rect,
  aspect: number,
  seen: ReadonlySet<string>,
): Rect | null {
  const moves: Move[] = [];
  const covers = (r: Rect) =>
    r.x <= anchor.x + EPS &&
    r.y <= anchor.y + EPS &&
    r.x + r.w >= anchor.x + anchor.w - EPS &&
    r.y + r.h >= anchor.y + anchor.h - EPS;

  // Bounds of the image in square space: [0,1] across, [0,aspect] down.
  const inside = (r: Rect) =>
    r.x >= -EPS && r.y >= -EPS && r.x + r.w <= 1 + EPS && r.y + r.h <= aspect + EPS;

  const slide = (x: number, y: number) => {
    const moved = { x, y, w: rect.w, h: rect.h };
    if (!covers(moved) || !inside(moved)) return;
    const dist = Math.abs(x - rect.x) + Math.abs(y - rect.y);
    if (dist <= EPS) return;
    moves.push({ rect: moved, kind: 0, cost: dist });
  };

  slide(o.x + o.w, rect.y); // right of it
  slide(o.x - rect.w, rect.y); // left of it
  slide(rect.x, o.y + o.h); // below it
  slide(rect.x, o.y - rect.h); // above it

  const trim = (r: Rect) => {
    if (r.w <= EPS || r.h <= EPS || !covers(r)) return;
    const lost = rect.w * rect.h - r.w * r.h;
    if (lost <= EPS) return;
    moves.push({ rect: r, kind: 1, cost: lost });
  };

  const right = o.x + o.w;
  trim({ x: right, y: rect.y, w: rect.x + rect.w - right, h: rect.h }); // cut the left side
  trim({ x: rect.x, y: rect.y, w: o.x - rect.x, h: rect.h }); // cut the right side
  const below = o.y + o.h;
  trim({ x: rect.x, y: below, w: rect.w, h: rect.y + rect.h - below }); // cut the top
  trim({ x: rect.x, y: rect.y, w: rect.w, h: o.y - rect.y }); // cut the bottom

  moves.sort((a, b) => a.kind - b.kind || a.cost - b.cost);
  for (const m of moves) {
    if (!seen.has(key(m.rect))) return m.rect;
  }
  return null;
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Positions are compared at a resolution far finer than a pixel, and no finer. */
function key(r: Rect): string {
  const q = (v: number) => Math.round(v * 1e6);
  return `${q(r.x)},${q(r.y)},${q(r.w)},${q(r.h)}`;
}

function toSquare(r: NormRect, aspect: number): Rect {
  return { x: r.x, y: r.y * aspect, w: r.w, h: r.h * aspect };
}

function fromSquare(r: Rect, aspect: number): NormRect {
  return { x: r.x, y: r.y / aspect, w: r.w, h: r.h / aspect };
}
