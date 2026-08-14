import type { Direction, LangCode, PixRect } from '../types';

export interface DirectionOptions {
  /** Aspect ratio past which a box is confidently one orientation. */
  threshold: number;
  /** What to assume when the box is near-square (e.g. a two-character retort). */
  fallback: Direction;
}

export const DIRECTION_DEFAULTS: Record<LangCode, DirectionOptions> = {
  // Japanese manga is mostly vertical, so ambiguous boxes lean vertical.
  ja: { threshold: 1.4, fallback: 'vertical' },
  // Latin scripts are horizontal in practice; vertical English is a design flourish.
  en: { threshold: 1.8, fallback: 'horizontal' },
  ko: { threshold: 1.6, fallback: 'horizontal' },
  zh: { threshold: 1.4, fallback: 'vertical' },
};

/**
 * Orientation of a single detected line, from its aspect ratio alone.
 *
 * Deliberately dumb: a taller-than-wide box is a column, a wider-than-tall box
 * is a row. It only has to be right often enough for grouping to work, because
 * manga-ocr reads whatever orientation it is handed. Do not grow this into a
 * classifier — if grouping is wrong, fix grouping.
 */
export function detectDirection(rect: PixRect, opts: DirectionOptions): Direction {
  if (rect.w <= 0 || rect.h <= 0) return opts.fallback;
  if (rect.h / rect.w >= opts.threshold) return 'vertical';
  if (rect.w / rect.h >= opts.threshold) return 'horizontal';
  return opts.fallback;
}

/**
 * Orientation of a whole block, by majority vote weighted by line area.
 * One stray short line should not flip a tall column of text.
 */
export function blockDirection(
  lines: readonly { rect: PixRect; direction: Direction }[],
  fallback: Direction,
): Direction {
  let vertical = 0;
  let horizontal = 0;
  for (const line of lines) {
    const weight = Math.max(1, line.rect.w * line.rect.h);
    if (line.direction === 'vertical') vertical += weight;
    else horizontal += weight;
  }
  if (vertical === horizontal) return fallback;
  return vertical > horizontal ? 'vertical' : 'horizontal';
}

/**
 * Apparent glyph size of a line: the measurement across the text, not along it.
 * For a vertical column that is its width; for a horizontal row, its height.
 * Grouping uses this to avoid merging body text with a giant sound effect.
 */
export function glyphSize(rect: PixRect, direction: Direction): number {
  return direction === 'vertical' ? rect.w : rect.h;
}
