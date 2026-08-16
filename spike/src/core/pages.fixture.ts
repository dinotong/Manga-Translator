import type { Direction, NormRect } from '../types';

/**
 * Ordinary manga pages, as geometry.
 *
 * ## What these are, and what they are not
 *
 * Hand-built layouts at the proportions the project has measured on real pages —
 * MangaDex 3496x4960, imhentai 1280x1808, the 13-block page from D-029 — **not**
 * detector output from a real image. The sample pages are copyrighted and stay
 * out of git, and producing real boxes needs a browser, ONNX and a GPU, none of
 * which a unit test has.
 *
 * So take them for what they are: a regression net, not a measurement. They pin
 * the behaviour of the layout and merge rules against ordinary bubble
 * arrangements so a future tweak cannot quietly change ordinary pages. They do
 * not prove the numbers are right on the owner's own page — only dropping that
 * page on the harness does that.
 */

export interface FixtureBlock {
  rect: NormRect;
  direction: Direction;
  /** Across-axis glyph size in image-width units, as core/merge-proposals wants it. */
  glyph: number;
}

export interface FixturePage {
  name: string;
  natural: { w: number; h: number };
  blocks: FixtureBlock[];
}

const jaBubble = (
  x: number,
  y: number,
  w: number,
  h: number,
  glyph = 0.02,
): FixtureBlock => ({ rect: { x, y, w, h }, direction: 'vertical', glyph });

export const PAGES: FixturePage[] = [
  {
    // Four bubbles, two speakers, plenty of white space. The commonest page in
    // any chapter and the one that must never change.
    name: 'mangadex-quiet',
    natural: { w: 3496, h: 4960 },
    blocks: [
      jaBubble(0.62, 0.06, 0.1, 0.18),
      jaBubble(0.18, 0.1, 0.09, 0.15),
      jaBubble(0.7, 0.45, 0.11, 0.2),
      jaBubble(0.12, 0.62, 0.1, 0.22),
    ],
  },
  {
    // The 13-block page measured on MangaDex in D-029. Dense, which is where
    // widened panels start meeting each other.
    name: 'mangadex-dense-13',
    natural: { w: 3496, h: 4960 },
    blocks: [
      jaBubble(0.72, 0.04, 0.09, 0.12),
      jaBubble(0.52, 0.06, 0.08, 0.1),
      jaBubble(0.2, 0.05, 0.1, 0.13),
      jaBubble(0.78, 0.2, 0.08, 0.11),
      jaBubble(0.5, 0.24, 0.09, 0.14),
      jaBubble(0.16, 0.26, 0.08, 0.1),
      jaBubble(0.74, 0.42, 0.1, 0.15),
      jaBubble(0.42, 0.45, 0.08, 0.12),
      jaBubble(0.14, 0.48, 0.09, 0.13),
      jaBubble(0.7, 0.66, 0.09, 0.14),
      jaBubble(0.44, 0.7, 0.1, 0.16),
      jaBubble(0.18, 0.72, 0.08, 0.11),
      jaBubble(0.46, 0.9, 0.12, 0.06),
    ],
  },
  {
    // imhentai's smaller pages: two bubbles, and the aspect ratio differs enough
    // to be worth carrying.
    name: 'imhentai-two',
    natural: { w: 1280, h: 1808 },
    blocks: [jaBubble(0.6, 0.12, 0.12, 0.2, 0.03), jaBubble(0.22, 0.55, 0.13, 0.18, 0.03)],
  },
  {
    // An English page: panelRect leaves horizontal text alone, so nothing here
    // should move at all.
    name: 'latin-horizontal',
    natural: { w: 1600, h: 2400 },
    blocks: [
      { rect: { x: 0.1, y: 0.08, w: 0.3, h: 0.05 }, direction: 'horizontal', glyph: 0.02 },
      { rect: { x: 0.55, y: 0.3, w: 0.32, h: 0.06 }, direction: 'horizontal', glyph: 0.02 },
      { rect: { x: 0.14, y: 0.7, w: 0.28, h: 0.05 }, direction: 'horizontal', glyph: 0.02 },
    ],
  },
  {
    /**
     * The page D-037 is about: three separate speech balloons abreast in the
     * upper half of one panel, English comic lettering, different beats of one
     * conversation. The model called them one sentence and the veto agreed.
     *
     * Built in pixels first, because every number here has to be a measurement
     * of a plausible page rather than a value chosen to make a point:
     *
     *   page          1600 x 2400, an ordinary scan width for a Latin comic
     *   lettering     30 px cap-height ink boxes, 42 px line pitch — comic
     *                 lettering is set tight, around 1.4x cap height
     *   balloons      two lines each, 150/190/160 px of text wide, so each text
     *                 block is 72 px tall: "WHERE'D / HE GO?", that shape
     *   spacing       100 px of balloon outline and white between one block of
     *                 text and the next, which is a normally lettered panel
     *   stagger       balloons sit at slightly different heights, as they do
     *
     * Why every check passes, which is the whole point of writing it down:
     * glyph is 30/1600, so the fragment limit of 2.5 glyphs across allows a
     * block 75 px tall and these are 72 — a two-line balloon reads as a
     * fragment. The 100 px gaps are inside the relaxed reach of 108 px. The
     * union is 700x112 px against 500x72 of text, which is a slack of 2.2 and
     * 1.7% of the page in swallowed artwork. Nothing here is contrived; it is
     * an ordinary panel.
     */
    name: 'latin-balloons-abreast',
    natural: { w: 1600, h: 2400 },
    blocks: [
      // x/w over 1600, y/h over 2400, glyph over 1600 — see FixtureBlock.
      {
        rect: { x: 150 / 1600, y: 210 / 2400, w: 150 / 1600, h: 72 / 2400 },
        direction: 'horizontal',
        glyph: 30 / 1600,
      },
      {
        rect: { x: 400 / 1600, y: 250 / 2400, w: 190 / 1600, h: 72 / 2400 },
        direction: 'horizontal',
        glyph: 30 / 1600,
      },
      {
        rect: { x: 690 / 1600, y: 215 / 2400, w: 160 / 1600, h: 72 / 2400 },
        direction: 'horizontal',
        glyph: 30 / 1600,
      },
    ],
  },
  {
    /**
     * The page that started all of this: an afterword. Freeform vertical
     * handwriting over the artwork, one sentence running down four columns of
     * uneven length that start at different heights, plus a separate short note
     * lower down.
     *
     * Reconstructed from the description, not measured — the point is that the
     * automatic thresholds refuse it (staggered starts, irregular spacing) while
     * the relaxed proximity check accepts it.
     */
    name: 'afterword-handwritten',
    natural: { w: 1600, h: 2300 },
    blocks: [
      jaBubble(0.72, 0.12, 0.024, 0.34),
      jaBubble(0.665, 0.17, 0.022, 0.26),
      jaBubble(0.61, 0.1, 0.025, 0.38),
      jaBubble(0.552, 0.2, 0.023, 0.22),
      jaBubble(0.3, 0.7, 0.024, 0.16),
      jaBubble(0.25, 0.74, 0.022, 0.12),
    ],
  },
];
