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

.mt-box {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 0.2em 0.3em;
  overflow: hidden;
  border-radius: 0.35em;
  background: rgba(255, 255, 255, var(--mt-box-opacity, 0.92));
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

.mt-text { transition: opacity 140ms ease; }

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

/* Peek: the pointer is over this box, so get out of the way of the artwork.
   The background and the translated text fade separately rather than the whole
   box getting one opacity, because opacity on the parent would cap the source
   text below too and there would be no way to keep it readable. */
.mt-box.peek { background-color: rgba(255, 255, 255, 0.04); }
.mt-box.peek .mt-text { opacity: 0.1; }
.mt-box.refused.peek {
  background-color: rgba(255, 236, 214, 0.06);
  border-color: rgba(208, 138, 58, 0.25);
}
.mt-box.refused.peek::after { opacity: 0.15; }

.mt-src {
  display: none;
  position: absolute;
  inset: 0;
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
