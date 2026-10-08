/**
 * Overlay CSS, kept as a string because it is injected into a closed shadow
 * root rather than the document.
 *
 * The geometry is the interesting part: every box is positioned in percent and
 * every font size is in `cqw`, so resizing the window, zooming, or a responsive
 * breakpoint all reflow the overlay correctly with no JavaScript running at
 * all. The only thing JS does on resize is move the layer onto the image.
 */
export const OVERLAY_CSS = `
:host {
  all: initial;
  position: absolute;
  top: 0;
  left: 0;
  /* One below the max so a site's own modal can still sit above us. */
  z-index: 2147483646;
  pointer-events: none;
}

.mt-layer {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  /* Makes cqw resolve against this layer instead of the viewport, which is what
     ties text size to the rendered image size. */
  container-type: size;
  pointer-events: none;
  contain: layout style;
}

/* The text panel: as wide as the Thai needs, as faint as the reader wants. */
.mt-box {
  position: absolute;
  /* left/top are the panel's centre. Positioning by centre is what lets the
     panel grow evenly when the pixel floor in font-size outgrows it. */
  translate: -50% -50%;
  /* Grow taller rather than clip when the readable size needs more lines than
     the detected bubble has room for. */
  min-height: max-content;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 0.2em 0.3em;
  overflow: hidden;
  border-radius: 0.35em;
  background: rgba(255, 255, 255, var(--mt-panel-opacity, 0.8));
  color: #111;
  font-family: "Sarabun", "Noto Sans Thai", "Leelawadee UI", system-ui, sans-serif;
  line-height: 1.18;
  text-align: center;
  /* Thai has no inter-word spaces, so the default breaking rules give one very
     long line. */
  word-break: break-word;
  overflow-wrap: anywhere;
  text-wrap: balance;
  /* Never auto, at any nesting depth.
   *
   * imhentai turns the page by clicking the image (a.next_img wraps it). A box
   * with pointer-events:auto becomes a hit target even though :host and
   * .mt-layer are none — that is how the property works, a descendant can opt
   * back in — and the click dies on the overlay instead of reaching the link.
   * Page turning then silently stops working over every translated bubble,
   * which is a far worse bug than the one hover was solving. Hover is resolved
   * by hit-testing pointermove in overlay.ts instead. */
  pointer-events: none;
  transition: background-color 140ms ease, border-color 140ms ease;
}

/* A short phrase is one line, never split inside itself. Thai has no spaces, so
   in a narrow panel overflow-wrap would break a four-letter word over four lines;
   widening the panel about its centre reads far better. */
.mt-box.short {
  min-width: max-content;
}

/* The cover plate: only as big as the ink it hides, and drawn inside the panel.
   Its alpha is not the reader's plate setting directly — it is what that setting
   works out to once the panel underneath is taken into account, so the two never
   composite darker than the stronger of them. See core/panel-shape.ts. */
.mt-plate {
  position: absolute;
  border-radius: 0.25em;
  background: rgba(255, 255, 255, var(--mt-plate-alpha, 1));
  pointer-events: none;
  transition: background-color 140ms ease;
}

.mt-text {
  /* Above the plate, which is a sibling earlier in the box. */
  position: relative;
  z-index: 1;
  transition: opacity 140ms ease;
}

.mt-box.refused {
  background: rgba(255, 236, 214, 0.95);
  border: 1px dashed #d08a3a;
}

.mt-box.refused::after {
  content: "ถูกปฏิเสธ";
  font-size: 2cqw;
  color: #a3631f;
  transition: opacity 140ms ease;
}

/* Peek: the pointer is over this box, so get completely out of the way.
   Fully transparent, not merely faint — the point of peeking is to look at the
   art, and a ghost of the translation lying across it is the thing being
   complained about, not a lighter version of the solution.
   The background and the text still fade as separate rules rather than one
   opacity on the parent, because the optional source-text overlay sits inside
   this box and must stay readable when that mode is on. */
.mt-box.peek {
  background-color: transparent;
  border-color: transparent;
}
/* Both layers, or peeking would uncover the art around the bubble and leave a
   solid plate sitting on the part the reader is actually pointing at. */
.mt-box.peek .mt-plate { background-color: transparent; }
.mt-box.peek .mt-text { opacity: 0; }
.mt-box.refused.peek {
  background-color: transparent;
  border-color: transparent;
}
.mt-box.refused.peek::after { opacity: 0; }

.mt-src {
  display: none;
  position: absolute;
  inset: 0;
  z-index: 2;
  align-items: center;
  justify-content: center;
  padding: 0.2em 0.3em;
  background: rgba(24, 24, 27, 0.95);
  color: #fff;
  writing-mode: horizontal-tb;
}

.mt-box.src .mt-src { display: flex; }
.mt-box.src .mt-text { visibility: hidden; }

/* Both at once: a solid plate would re-cover the art the peek just uncovered,
   so the source is drawn straight onto the picture with an outline instead. */
.mt-box.src.peek .mt-src {
  background: transparent;
  text-shadow: 0 0 2px #000, 0 1px 3px #000, 0 0 7px #000;
}

.mt-status {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  max-width: 22em;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(17, 17, 20, 0.82);
  color: #fff;
  font: 500 12px/1.4 system-ui, sans-serif;
  white-space: nowrap;
  pointer-events: none;
}

.mt-status.err {
  background: rgba(150, 30, 30, 0.92);
  white-space: normal;
}
`;
