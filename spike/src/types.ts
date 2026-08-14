/**
 * Canonical types for the OCR pipeline.
 *
 * TWO coordinate spaces, and the distinction matters:
 *
 *   PixRect  — pixels in the working bitmap. All geometry math happens here.
 *   NormRect — [0,1] against the image's natural size. Storage and handoff only.
 *
 * Why not do everything in normalized space? Because x and y normalize by
 * DIFFERENT divisors. On a 3496x4960 page, w:0.05 is 175px but h:0.05 is 248px.
 * Any code comparing a width to a height — aspect ratio, gap distance, "is this
 * line vertical" — is silently wrong in normalized space. So: math in pixels,
 * normalize once at the boundary, and never round-trip back.
 */

export type LangCode = 'ja' | 'en' | 'ko' | 'zh';
export type Direction = 'vertical' | 'horizontal';

export interface Size {
  w: number;
  h: number;
}

/** Pixel-space rect in whatever bitmap produced it. Working space. */
export interface PixRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Normalized [0,1] against natural image size. Cache/overlay space. */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One line of text as returned by the detector. Detector output is pixel-space. */
export interface TextLine {
  rect: PixRect;
  /** Detector confidence, 0..1. */
  score: number;
  direction: Direction;
}

/** A group of lines that should be read together — usually one speech bubble. */
export interface TextBlock {
  rect: PixRect;
  direction: Direction;
  lines: TextLine[];
  /** Mean of member line scores. */
  score: number;
}

/** A block after recognition. */
export interface RecognizedBlock extends TextBlock {
  text: string;
  lang: LangCode;
}

/** What the pipeline hands off: normalized, ready to cache or render. */
export interface OutputBlock {
  rect: NormRect;
  /** What gets rendered — the translation when there is one. */
  text: string;
  /** Original text, kept for the "show source on hover" display mode. */
  source?: string;
  direction: Direction;
  lang: LangCode;
  score: number;
}

/** Stage timings in ms. Every stage is measured — guessing is how spikes lie. */
export interface StageTimings {
  decode: number;
  detect: number;
  group: number;
  recognize: number;
  total: number;
  /** Per-block recognition times, to see whether cost is per-page or per-bubble. */
  perBlock: number[];
}

export interface PipelineResult {
  blocks: OutputBlock[];
  natural: Size;
  detSize: Size;
  timings: StageTimings;
  detectorId: string;
  recognizerId: string;
}
