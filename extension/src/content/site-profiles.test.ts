import { describe, expect, it } from 'vitest';
import { profileFor } from './site-profiles';

const at = (url: string) => profileFor(new URL(url));
const pageOf = (url: string) => at(url).pageNumber?.(new URL(url)) ?? null;
const setOf = (url: string) => at(url).setKey?.(new URL(url)) ?? null;

/** Enough of a Document for `prefetch.total`, which only ever does one lookup. */
const docWith = (text: string | null): Document =>
  ({ querySelector: () => (text === null ? null : { textContent: text }) }) as unknown as Document;

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

/**
 * The three sites added on 2026-08-16. Every URL and every DOM fact asserted
 * below was read off the live site through CDP that day, on the browser profile
 * the owner reads in — not inferred from the shape of the URL.
 */
describe('isReaderPage — luscious', () => {
  it('/albums/{slug}/read/ is the reader, on both hosts', () => {
    expect(kind('https://members.luscious.net/albums/matchmaking-mishaps_602401/read/')).toBe(true);
    expect(
      kind('https://www.luscious.net/albums/matchmaking-mishaps_602401/read/?index=3&id=59240823'),
    ).toBe(true);
  });

  it("the album's own page, the album lists and the front page are listings", () => {
    // Measured: twelve images 400 px or wider on this page, all thumbnails.
    expect(kind('https://members.luscious.net/albums/matchmaking-mishaps_602401/')).toBe(false);
    expect(kind('https://www.luscious.net/albums/list/?album_type=manga&page=1')).toBe(false);
    expect(kind('https://www.luscious.net/albums/new/manga/')).toBe(false);
    expect(kind('https://www.luscious.net/hentai-manga/ongoing/')).toBe(false);
    expect(kind('https://www.luscious.net/')).toBe(false);
  });

  it('reads the page from ?index, one-based, and only when it is there', () => {
    expect(pageOf('https://members.luscious.net/albums/a_1/read/?index=0&id=59240797')).toBe(1);
    expect(pageOf('https://members.luscious.net/albums/a_1/read/?index=3&id=59240823')).toBe(4);
    expect(pageOf('https://members.luscious.net/albums/a_1/read/')).toBe(null);
    expect(pageOf('https://members.luscious.net/albums/a_1/read/?index=x')).toBe(null);
  });

  it('keys the set on the album slug', () => {
    expect(setOf('https://members.luscious.net/albums/matchmaking-mishaps_602401/read/?index=2')).toBe(
      'matchmaking-mishaps_602401',
    );
    expect(setOf('https://www.luscious.net/albums/list/?album_type=manga')).toBe(null);
  });

  it('never prefetches: the image URL carries a per-picture ULID', () => {
    expect(at('https://www.luscious.net/albums/a_1/read/').prefetch).toBeUndefined();
  });
});

describe('isReaderPage — e-hentai', () => {
  it('both readers count, on both hosts', () => {
    expect(kind('https://e-hentai.org/mpv/4119160/05fb2b4929/#page1')).toBe(true);
    expect(kind('https://e-hentai.org/s/2f93dafd0c/4119160-3')).toBe(true);
    expect(kind('https://exhentai.org/mpv/4119160/05fb2b4929/')).toBe(true);
  });

  it('the gallery page, the front page and searches are listings', () => {
    expect(kind('https://e-hentai.org/g/4119160/05fb2b4929/')).toBe(false);
    expect(kind('https://e-hentai.org/')).toBe(false);
    expect(kind('https://e-hentai.org/?f_search=test')).toBe(false);
    expect(kind('https://e-hentai.org/tag/language:japanese')).toBe(false);
  });

  it('answers with a page number only where the URL really names one', () => {
    expect(pageOf('https://e-hentai.org/s/2f93dafd0c/4119160-3')).toBe(3);
    // Measured: scrolling 3,700 px through MPV left the hash at #page1. It is
    // the last thumbnail clicked, not the page being read.
    expect(pageOf('https://e-hentai.org/mpv/4119160/05fb2b4929/#page7')).toBe(null);
  });

  it('keys both readers on the same gallery id', () => {
    expect(setOf('https://e-hentai.org/mpv/4119160/05fb2b4929/#page1')).toBe('4119160');
    expect(setOf('https://e-hentai.org/s/2f93dafd0c/4119160-3')).toBe('4119160');
  });

  it('never prefetches: every page is a signed link to a different Hath node', () => {
    expect(at('https://e-hentai.org/mpv/4119160/05fb2b4929/').prefetch).toBeUndefined();
  });
});

describe('isReaderPage — nhentai', () => {
  it('/g/{id}/{n}/ is the reader and /g/{id}/ is its listing', () => {
    expect(kind('https://nhentai.net/g/673062/1/')).toBe(true);
    expect(kind('https://nhentai.net/g/673062/34/')).toBe(true);
    expect(kind('https://nhentai.net/g/673062/')).toBe(false);
    expect(kind('https://nhentai.net/')).toBe(false);
    expect(kind('https://nhentai.net/search/?q=test')).toBe(false);
    expect(kind('https://nhentai.net/random/')).toBe(false);
  });

  it('reads the page and the gallery from the path', () => {
    expect(pageOf('https://nhentai.net/g/673062/7/')).toBe(7);
    expect(pageOf('https://nhentai.net/g/673062/')).toBe(null);
    expect(setOf('https://nhentai.net/g/673062/7/')).toBe('673062');
  });

  it('predicts the next image by the page number in the filename', () => {
    const p = at('https://nhentai.net/g/673062/7/').prefetch;
    expect(p).toBeDefined();
    // Measured: the shard host stays whatever the current page came from, and
    // the shards mirror each other — 24 of 24 in-range guesses loaded.
    expect(p?.imageUrl('https://i1.nhentai.net/galleries/4121283/7.webp', 1)).toBe(
      'https://i1.nhentai.net/galleries/4121283/8.webp',
    );
    // Older galleries are .jpg; the extension is carried over, not assumed.
    expect(p?.imageUrl('https://i3.nhentai.net/galleries/696599/1.jpg', 5)).toBe(
      'https://i3.nhentai.net/galleries/696599/6.jpg',
    );
  });

  it('reads the length of the book off the counter already on the page', () => {
    const p = at('https://nhentai.net/g/673062/7/').prefetch;
    expect(p?.total(docWith('34'))).toBe(34);
    expect(p?.total(docWith(' 34 '))).toBe(34);
    // No counter, or nonsense in it, means "unknown" — not "guess forever".
    expect(p?.total(docWith(null))).toBe(null);
    expect(p?.total(docWith('lots'))).toBe(null);
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
