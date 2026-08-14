import type { Size } from '../types';

/**
 * Input preparation for the PP-OCR detection model, and the inverse mapping
 * needed to put its boxes back in the caller's coordinate space.
 *
 * Split out from the detector so the arithmetic — which is where sizing bugs
 * hide — can be unit tested without ONNX.
 */

/** ImageNet statistics; PaddleOCR normalizes with these after scaling to 0..1. */
export const MEAN = [0.485, 0.456, 0.406] as const;
export const STD = [0.229, 0.224, 0.225] as const;

/** The model's convolution stack downsamples by 32, so both sides must divide by it. */
export const STRIDE = 32;

export interface DetInputPlan {
  /** Size actually fed to the model: multiple of STRIDE, capped by maxSide. */
  input: Size;
  /** Multiply model-space coordinates by this to get back to source pixels. */
  scaleBack: { x: number; y: number };
}

/**
 * Pick the model input size for a given source.
 *
 * Cost is roughly linear in pixel count — 640x960 takes ~300ms on single-thread
 * wasm — so maxSide is the main speed lever. Rounding is to the nearest stride
 * rather than up, to avoid quietly enlarging an already-capped image.
 */
export function planDetInput(source: Size, maxSide = 960): DetInputPlan {
  if (source.w <= 0 || source.h <= 0) {
    return { input: { w: STRIDE, h: STRIDE }, scaleBack: { x: 1, y: 1 } };
  }

  const scale = Math.min(1, maxSide / Math.max(source.w, source.h));
  const input = {
    w: Math.max(STRIDE, Math.round((source.w * scale) / STRIDE) * STRIDE),
    h: Math.max(STRIDE, Math.round((source.h * scale) / STRIDE) * STRIDE),
  };

  // Rounding to a stride distorts the aspect ratio slightly, so the inverse
  // scale is derived per-axis from the sizes we actually used — not from the
  // nominal scale factor.
  return {
    input,
    scaleBack: { x: source.w / input.w, y: source.h / input.h },
  };
}

/**
 * RGBA bytes -> normalized NCHW float32, the layout the model expects.
 *
 * Channel-planar, not interleaved: all red, then all green, then all blue.
 * Getting this wrong produces a plausible-looking but empty probability map,
 * which is a genuinely annoying bug to chase.
 */
export function rgbaToNchw(rgba: Readonly<Uint8ClampedArray>, size: Size): Float32Array {
  const { w, h } = size;
  const plane = w * h;
  const out = new Float32Array(3 * plane);

  for (let p = 0, i = 0; p < plane; p++, i += 4) {
    out[p] = (rgba[i]! / 255 - MEAN[0]) / STD[0];
    out[plane + p] = (rgba[i + 1]! / 255 - MEAN[1]) / STD[1];
    out[2 * plane + p] = (rgba[i + 2]! / 255 - MEAN[2]) / STD[2];
  }
  return out;
}

/**
 * Grow a box by a fraction of its short side.
 *
 * DB detectors are trained on shrunk polygons, so raw output sits inside the
 * real glyph extent. PaddleOCR compensates with a polygon unclip; for
 * axis-aligned boxes a proportional expand is a close enough approximation.
 * Keep it small — over-expanding makes neighbouring bubbles touch, and merging
 * them is grouping's decision to make, not the detector's.
 */
export function expandBox(
  box: { x: number; y: number; w: number; h: number },
  ratio: number,
  bounds: Size,
) {
  const d = Math.min(box.w, box.h) * ratio;
  const x = Math.max(0, box.x - d);
  const y = Math.max(0, box.y - d);
  return {
    x,
    y,
    w: Math.min(bounds.w - x, box.w + d * 2),
    h: Math.min(bounds.h - y, box.h + d * 2),
  };
}
