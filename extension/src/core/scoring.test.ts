import { describe, expect, it } from 'vitest';
import { type CandidateFeatures, PASS_SCORE, isLongStrip, scoreCandidate } from './scoring';

const base: CandidateFeatures = {
  natural: { w: 1280, h: 1808 },
  rendered: { w: 1150, h: 1652 },
  viewport: { w: 1600, h: 900 },
  text: '',
  ancestorText: '',
  inChrome: false,
  inExternalLink: false,
};

const f = (patch: Partial<CandidateFeatures>): CandidateFeatures => ({ ...base, ...patch });

describe('scoreCandidate', () => {
  it('accepts a typical manga page', () => {
    expect(scoreCandidate(base)).toBeGreaterThanOrEqual(PASS_SCORE);
  });

  it('accepts a MangaDex page rendered small with object-fit', () => {
    const score = scoreCandidate(
      f({
        natural: { w: 3496, h: 4960 },
        rendered: { w: 507, h: 720 },
        ancestorText: 'md--page',
      }),
    );
    expect(score).toBeGreaterThanOrEqual(PASS_SCORE);
  });

  it('accepts a preloaded page that has no layout yet', () => {
    // MangaDex keeps the next pages in the DOM at 0x0. Those are the best
    // candidates to work on early, so no rendered box must not disqualify them.
    const score = scoreCandidate(f({ rendered: { w: 0, h: 0 }, ancestorText: 'md--reader-pages' }));
    expect(score).toBeGreaterThanOrEqual(PASS_SCORE);
  });

  it('rejects anything under 300px outright', () => {
    expect(scoreCandidate(f({ natural: { w: 200, h: 200 } }))).toBeLessThan(0);
  });

  it('rejects avatars and logos by name even at a plausible size', () => {
    const score = scoreCandidate(f({ natural: { w: 600, h: 600 }, text: 'user-avatar' }));
    expect(score).toBeLessThan(PASS_SCORE);
  });

  it('rejects images inside site chrome', () => {
    expect(scoreCandidate(f({ inChrome: true }))).toBeLessThan(PASS_SCORE);
  });

  it('accepts a webtoon strip despite an extreme aspect ratio', () => {
    const score = scoreCandidate(
      f({ natural: { w: 800, h: 12000 }, rendered: { w: 800, h: 12000 } }),
    );
    expect(score).toBeGreaterThanOrEqual(PASS_SCORE);
  });
});

describe('isLongStrip', () => {
  it('is true for a webtoon and false for a page', () => {
    expect(isLongStrip({ w: 800, h: 12000 })).toBe(true);
    expect(isLongStrip({ w: 1280, h: 1808 })).toBe(false);
  });
});
