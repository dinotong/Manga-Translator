import { describe, expect, it } from 'vitest';
import { type PageInView, readingNow } from './foreground';

/** A strip page, measured the way entrypoints/content.ts measures one. */
const page = (key: string, distance: number, onScreen = true): PageInView => ({
  key,
  distance,
  onScreen,
});

describe('readingNow', () => {
  it('picks the page nearest the middle of the viewport', () => {
    expect(readingNow([page('a', 900), page('b', 120), page('c', 1400)])).toBe('b');
  });

  it('discriminates on a long strip, where everything is on screen', () => {
    // The measured shape: 1,700 px pages in a 768 px viewport, three of them
    // overlapping the viewport at once. Under the old on-screen test all three
    // were foreground and none of them could ever batch.
    expect(readingNow([page('prev', 1700), page('now', 60), page('next', 1640)])).toBe('now');
  });

  it('leaves nobody in front of the reader as nobody', () => {
    // Not "the least far away thing in the document". A reader who has scrolled
    // clear of every page is reading none of them, and work for all of them may
    // wait for company.
    expect(readingNow([page('a', 3000, false), page('b', 5000, false)])).toBeNull();
    expect(readingNow([])).toBeNull();
  });

  it('never picks an off-screen page over an on-screen one, however close', () => {
    expect(readingNow([page('off', 10, false), page('on', 700)])).toBe('on');
  });

  it('ignores a page with no measurable position', () => {
    // A preloaded page has no box. It cannot be the one being read, and letting
    // an unmeasurable distance win would make it foreground on every site that
    // preloads.
    expect(readingNow([page('ghost', Number.POSITIVE_INFINITY), page('real', 800)])).toBe('real');
    expect(readingNow([page('ghost', Number.NaN)])).toBeNull();
  });

  it('is the same answer as before on a paged reader', () => {
    // One page on screen: still foreground, exactly as when the test was
    // `inViewport`. This change is only supposed to bite on a strip.
    expect(readingNow([page('only', 4)])).toBe('only');
  });

  it('breaks a tie towards the earlier page', () => {
    // A two-page spread, both equidistant. Passing them in document order means
    // the reader moving forwards gets the one they reached first.
    expect(readingNow([page('left', 300), page('right', 300)])).toBe('left');
  });
});
