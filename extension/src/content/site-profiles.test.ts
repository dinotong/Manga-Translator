import { describe, expect, it } from 'vitest';
import { profileFor } from './site-profiles';

/**
 * Every URL here was opened in a real browser on 2026-08-15 to confirm which
 * kind of page it is, rather than assumed from its shape.
 */
const kind = (url: string): boolean | undefined => profileFor(new URL(url)).isReaderPage?.(new URL(url));

describe('isReaderPage — imhentai', () => {
  it('/view/{id}/{n}/ is the reader', () => {
    expect(kind('https://imhentai.xxx/view/1474885/1/')).toBe(true);
    expect(kind('https://imhentai.xxx/view/1474885/9/')).toBe(true);
  });

  it('/gallery/{id}/ is the listing, not the reader', () => {
    // The word `gallery` used to be a *positive* signal in the per-image
    // scorer, which is backwards: on this site it names the index of covers.
    expect(kind('https://imhentai.xxx/gallery/1474885/')).toBe(false);
  });

  it('the front page and search results are listings', () => {
    expect(kind('https://imhentai.xxx/')).toBe(false);
    expect(kind('https://imhentai.xxx/search/?key=manga')).toBe(false);
    expect(kind('https://imhentai.com/tag/yaoi/')).toBe(false);
  });
});

describe('isReaderPage — MangaDex', () => {
  it('/chapter/{uuid} is the reader, with or without a page number', () => {
    expect(kind('https://mangadex.org/chapter/063ed231-b055-4683-bc1f-6abd6bcccb9b')).toBe(true);
    expect(kind('https://mangadex.org/chapter/063ed231-b055-4683-bc1f-6abd6bcccb9b/1')).toBe(true);
  });

  it('title pages, the title index and the front page are listings', () => {
    expect(kind('https://mangadex.org/title/9d351a80-5037-4334-a020-6985899f5b1f')).toBe(false);
    expect(kind('https://mangadex.org/title/9d351a80-5037-4334-a020-6985899f5b1f/some-slug')).toBe(
      false,
    );
    expect(kind('https://mangadex.org/titles/latest')).toBe(false);
    expect(kind('https://mangadex.org/')).toBe(false);
    expect(kind('https://mangadex.org/search?q=test')).toBe(false);
  });
});

describe('isReaderPage — unknown sites', () => {
  it('has no answer, so core/page-kind.ts decides from the layout', () => {
    expect(kind('https://www.mangaread.org/manga/swordmasters-youngest-son/chapter-207/')).toBe(
      undefined,
    );
    expect(kind('https://example.com/')).toBe(undefined);
  });
});
