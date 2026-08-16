import { describe, expect, it } from 'vitest';
import { blocksFor, OCR_RECORD_FORMAT, ocrKey, servesGrouping, type OcrBlockRecord } from './db';

/**
 * Turning model grouping off has to change what the reader sees on pages they
 * have already read. It did not, for one release: the merge was written into the
 * OCR record and `runJob` serves the cached record, so the only ways out were
 * clearing the whole cache or right-clicking every image. Neither is something a
 * reader should have to know about.
 */

const block = (src: string, x = 0): OcrBlockRecord => ({
  rect: { x, y: 0.1, w: 0.1, h: 0.2 },
  src,
  direction: 'vertical',
  score: 0.9,
});

const merged = (src: string, parts: OcrBlockRecord[]): OcrBlockRecord => ({
  ...block(src),
  rect: { x: 0, y: 0.1, w: 0.3, h: 0.2 },
  parts,
});

describe('blocksFor', () => {
  it('serves the record as written when grouping is on', () => {
    const blocks = [merged('ABC', [block('A', 0), block('B', 0.1), block('C', 0.2)])];
    expect(blocksFor(blocks, true)).toEqual(blocks);
  });

  it('hands back the blocks underneath a merge when grouping is off', () => {
    const parts = [block('A', 0), block('B', 0.1), block('C', 0.2)];
    expect(blocksFor([merged('ABC', parts)], false)).toEqual(parts);
  });

  it('leaves a page with no merges identical under either setting', () => {
    const blocks = [block('A', 0), block('B', 0.4)];
    expect(blocksFor(blocks, false)).toEqual(blocks);
    expect(blocksFor(blocks, true)).toEqual(blocks);
  });

  it('keeps unmerged neighbours in place around one that was merged', () => {
    const parts = [block('A', 0), block('B', 0.1)];
    const blocks = [block('before', 0.5), merged('AB', parts), block('after', 0.8)];
    expect(blocksFor(blocks, false).map((b) => b.src)).toEqual(['before', 'A', 'B', 'after']);
  });

  it('keeps a merge whose parts went missing rather than dropping the text', () => {
    // A model that named a group but returned nothing usable for its members
    // leaves an empty list. The merged reading is still the best thing we have.
    const blocks = [{ ...block('ABC'), parts: [] }];
    expect(blocksFor(blocks, false).map((b) => b.src)).toEqual(['ABC']);
  });

  it('does not hand the caller the stored array to mutate', () => {
    const blocks = [block('A')];
    expect(blocksFor(blocks, true)).not.toBe(blocks);
  });
});

describe('servesGrouping', () => {
  it('serves anything when grouping is on', () => {
    expect(servesGrouping({ format: OCR_RECORD_FORMAT }, true)).toBe(true);
    expect(servesGrouping({}, true)).toBe(true);
  });

  it('serves a record that can have its merges dropped', () => {
    expect(servesGrouping({ format: OCR_RECORD_FORMAT }, false)).toBe(true);
  });

  it('refuses a record from before merges were reversible', () => {
    // Unmarked records may contain a baked-in merge and there is no way to tell
    // — a merge leaves nothing behind but a union rectangle. Re-reading that one
    // page is the only honest answer, and it happens once.
    expect(servesGrouping({}, false)).toBe(false);
    expect(servesGrouping({ format: 1 }, false)).toBe(false);
  });
});

describe('ocrKey', () => {
  it('separates readings by detector, recognizer, language and image', () => {
    expect(ocrKey('det@1', 'gemini-vision@m', 'ja', 'abc')).toBe('det@1:gemini-vision@m:ja:abc');
    expect(ocrKey('det@1', 'gemini-vision@m', 'en', 'abc')).not.toBe(
      ocrKey('det@1', 'gemini-vision@m', 'ja', 'abc'),
    );
  });
});
