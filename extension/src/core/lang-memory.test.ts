import { describe, expect, it } from 'vitest';
import { FLIP_MARGIN, type LangEvidence, MAX_REREADS_PER_SET, observePage } from './lang-memory';
import type { LangCode } from '../types';

/**
 * Replay a gallery, one page at a time, the way the pipeline does.
 *
 * `scripts` is what each page actually reads as. The working language carries
 * from page to page exactly as `Settings.perSet` carries it, and every re-read
 * is counted, because the cost of this bug was measured in requests.
 */
function readGallery(scripts: readonly LangCode[], start: LangCode | null = null) {
  let evidence: LangEvidence = {};
  let working = start;
  let rereads = 0;
  const flips: string[] = [];

  for (const detected of scripts) {
    // What the page was processed as: whatever the set was working in, or the
    // 'auto' default of ja on the very first page. Mirrors resolveDetectionLang.
    const processedAs: LangCode = working ?? 'ja';
    const d = observePage(evidence, working, detected, processedAs);
    evidence = { counts: d.counts, rereads: d.rereads };
    if (d.working !== working) flips.push(`${working ?? 'auto'}->${d.working}`);
    if (d.reread) rereads++;
    working = d.working;
  }
  return { working, rereads, flips, evidence };
}

describe('observePage', () => {
  describe('the oscillation this exists to stop', () => {
    it('settles a gallery whose pages alternate between two scripts', () => {
      // The measured case: English lettering over artwork containing Japanese
      // packaging and signage, so the script really does change page to page.
      // Before this, every page overwrote the memory, disagreed with the page
      // before it, and bought a whole extra request to do it.
      const alternating: LangCode[] = ['ja', 'en', 'ja', 'en', 'ja', 'en', 'ja', 'en'];
      const run = readGallery(alternating);

      expect(run.rereads).toBeLessThanOrEqual(MAX_REREADS_PER_SET);
      // One decision at the start, and then it holds for the whole gallery.
      expect(run.flips.length).toBeLessThanOrEqual(1);
      expect(run.working).toBe('ja');
    });

    it('settles whichever script the alternation starts with', () => {
      const run = readGallery(['en', 'ja', 'en', 'ja', 'en', 'ja']);
      expect(run.rereads).toBeLessThanOrEqual(MAX_REREADS_PER_SET);
      expect(run.working).toBe('en');
    });

    it('never spends more than the cap, however long the gallery oscillates', () => {
      const long: LangCode[] = Array.from({ length: 200 }, (_, i) => (i % 2 ? 'en' : 'ja'));
      expect(readGallery(long).rereads).toBeLessThanOrEqual(MAX_REREADS_PER_SET);
    });

    it('converges on a noisy mixed gallery rather than following the last page', () => {
      // Mostly Japanese, with English pages scattered through it.
      const noisy: LangCode[] = ['ja', 'ja', 'en', 'ja', 'en', 'ja', 'ja', 'en', 'ja'];
      const run = readGallery(noisy);
      expect(run.working).toBe('ja');
      expect(run.rereads).toBe(0); // it was ja from the first page and stayed ja
    });
  });

  describe('the correction D-038 added, which must still work', () => {
    it('re-reads once when the first page proves the auto guess wrong', () => {
      // An English gallery: 'auto' processes page one as ja, the reply reads as
      // en, and that page's geometry was computed under vertical rules.
      const d = observePage(undefined, null, 'en', 'ja');
      expect(d.working).toBe('en');
      expect(d.reread).toBe(true);
      expect(d.rereads).toBe(1);
    });

    it('does not re-read when the guess was already right', () => {
      const d = observePage(undefined, null, 'ja', 'ja');
      expect(d.working).toBe('ja');
      expect(d.reread).toBe(false);
      expect(d.rereads).toBe(0);
    });

    it('spends the correction once per set and never again', () => {
      const spent: LangEvidence = { counts: { en: 1, ja: 3 }, rereads: MAX_REREADS_PER_SET };
      // Evidence has moved enough to change the working language...
      const d = observePage(spent, 'en', 'ja', 'en');
      expect(d.working).toBe('ja');
      // ...but the page in hand is not read again for it.
      expect(d.reread).toBe(false);
      expect(d.rereads).toBe(MAX_REREADS_PER_SET);
    });

    it('still switches the working language after the cap is spent', () => {
      // The cap buys no more corrections; it must not freeze the set into a
      // language the evidence has clearly left behind, because every later page
      // would then be processed under the wrong direction rules for free.
      const run = readGallery(['en', 'ja', 'ja', 'ja', 'ja']);
      expect(run.working).toBe('ja');
      expect(run.rereads).toBe(1); // the first page only
    });
  });

  describe('hysteresis', () => {
    it('holds the incumbent against a tie', () => {
      const d = observePage({ counts: { ja: 1 } }, 'ja', 'en', 'ja');
      expect(d.working).toBe('ja');
      expect(d.reread).toBe(false);
    });

    it(`holds the incumbent until the challenger leads by ${FLIP_MARGIN}`, () => {
      const one = observePage({ counts: { ja: 1, en: 1 } }, 'ja', 'en', 'ja');
      expect(one.working).toBe('ja'); // en leads by 1

      const two = observePage({ counts: { ja: 1, en: 2 } }, 'ja', 'en', 'ja');
      expect(two.working).toBe('en'); // en leads by 2
    });

    it('lets the first real evidence decide when nothing is settled yet', () => {
      const d = observePage(undefined, null, 'ko', 'ja');
      expect(d.working).toBe('ko');
    });
  });

  describe('bookkeeping', () => {
    it('accumulates counts across pages', () => {
      const run = readGallery(['ja', 'ja', 'en']);
      expect(run.evidence.counts).toEqual({ ja: 2, en: 1 });
    });

    it('does not mutate the evidence it was given', () => {
      const before: LangEvidence = { counts: { ja: 1 }, rereads: 0 };
      observePage(before, 'ja', 'en', 'ja');
      expect(before.counts).toEqual({ ja: 1 });
    });

    it('decides the same way whatever order the counts sit in', () => {
      const a = observePage({ counts: { ja: 2, en: 4 } }, null, 'en', 'ja');
      const b = observePage({ counts: { en: 4, ja: 2 } }, null, 'en', 'ja');
      expect(a.working).toBe(b.working);
    });

    it('survives a corrupt reread count rather than trusting it', () => {
      const d = observePage({ counts: { ja: 1 }, rereads: -5 }, 'ja', 'en', 'en');
      expect(d.rereads).toBeGreaterThanOrEqual(0);
    });
  });
});
