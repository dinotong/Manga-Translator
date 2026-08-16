import { describe, expect, it } from 'vitest';
import { profileFor } from './site-profiles';

const at = (url: string) => profileFor(new URL(url));
const pageOf = (url: string) => at(url).pageNumber?.(new URL(url)) ?? null;
const setOf = (url: string) => at(url).setKey?.(new URL(url)) ?? null;

/** Enough of a Document for `prefetch.total`, which only ever does one lookup. */
const docWith = (text: string | null): Document =>
  ({ querySelector: () => (text === null ? null : { textContent: text }) }) as unknown as Document;

/**
 * Enough of a Document for `prefetch.published`.
 *
 * Hand-rolled rather than jsdom on purpose: these tests are about what the two
 * sites really put in their markup, and every shape below was read off the live
 * readers through CDP on 2026-08-16. A DOM implementation would only prove that
 * `querySelectorAll` works.
 */
const docOf = (bySelector: Record<string, unknown[]>): Document =>
  ({
    querySelectorAll: (sel: string) => bySelector[sel] ?? [],
  }) as unknown as Document;

const box = (top: number, w = 1014, h = 1500) => ({
  getBoundingClientRect: () => ({ top, width: w, height: h }),
});

/** One `.picture-row`, as luscious mounts it: the index lives on the wrapper. */
const lusciousRow = (index: number, src: string | null, top: number) => ({
  ...box(top),
  parentElement: { getAttribute: (n: string) => (n === 'data-row-key' ? `row-${index}-01M054M9T4ESFGA1KXG0J3FEEV` : null) },
  querySelector: (sel: string) => (sel === 'picture img' && src !== null ? { src } : null),
});

/** One decoded MPV page: the page number is the element id. */
const mpvImage = (page: number, src: string, top: number) => ({
  ...box(top, 1014, 1818),
  id: `imgsrc_${page}`,
  src,
});

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

  it('never *guesses* an image URL: they carry a per-picture ULID', () => {
    // The reason D-033 gave for having no prefetch at all. It is still true,
    // and it is still why there is no `imageUrl` here.
    expect(at('https://www.luscious.net/albums/a_1/read/').prefetch?.imageUrl).toBeUndefined();
  });

  it('reads the upcoming pages the album has already mounted', () => {
    // Measured at scrollY 10,000 of a real album: five rows mounted, the reader
    // on row 6, two rows below already carrying their real src — one of them
    // still undecoded and lazy, which is exactly the page the ordinary path
    // cannot start on yet.
    const doc = docOf({
      '.picture-row': [
        lusciousRow(4, 'https://ah-img.luscious.net/x/5.jpg', -3068),
        lusciousRow(5, 'https://ah-img.luscious.net/x/6.jpg', -1360),
        lusciousRow(6, 'https://ah-img.luscious.net/x/7.jpg', 348),
        lusciousRow(7, 'https://ah-img.luscious.net/x/8.jpg', 1806),
        lusciousRow(8, 'https://ah-img.luscious.net/x/9.jpg', 3264),
      ],
    });
    const published = at('https://members.luscious.net/albums/a_1/read/').prefetch?.published?.(doc);
    // `data-row-key` is zero-based and album-wide; every other page number in
    // this file is one-based, so it is converted here rather than downstream.
    expect(published?.map((p) => p.page)).toEqual([5, 6, 7, 8, 9]);
    expect(published?.map((p) => p.top)).toEqual([-3068, -1360, 348, 1806, 3264]);
    expect(published?.[4]?.url).toBe('https://ah-img.luscious.net/x/9.jpg');
  });

  it('skips a row the site has mounted but not filled in', () => {
    const doc = docOf({
      '.picture-row': [
        lusciousRow(0, null, 150),
        lusciousRow(1, 'https://ah-img.luscious.net/x/2.jpg', 2058),
      ],
    });
    expect(at('https://members.luscious.net/albums/a_1/read/').prefetch?.published?.(doc)).toEqual([
      { page: 2, url: 'https://ah-img.luscious.net/x/2.jpg', top: 2058 },
    ]);
  });

  it('has no opinion about the album length', () => {
    // The reader's markup does not carry one, and asking their GraphQL endpoint
    // would be the request this whole block is forbidden to cost.
    expect(at('https://members.luscious.net/albums/a_1/read/').prefetch?.total).toBeUndefined();
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

  it('never *guesses*: every page is a signed link to a different Hath node', () => {
    expect(at('https://e-hentai.org/mpv/4119160/05fb2b4929/').prefetch?.imageUrl).toBeUndefined();
  });

  it('reads the decoded window MPV keeps, taking the page number from the id', () => {
    // Measured from the top of a real 26-page gallery.
    const doc = docOf({
      '#pane_images img[id^="imgsrc_"]': [
        mpvImage(1, 'https://a.hath.network/h/aaa/keystamp=1/01.webp', 3),
        mpvImage(2, 'https://b.hath.network/h/bbb/keystamp=2/02.webp', 1847),
        mpvImage(3, 'https://c.hath.network/h/ccc/keystamp=3/03.webp', 3709),
      ],
      '.mimg': new Array(26).fill({}),
    });
    const p = at('https://e-hentai.org/mpv/4123216/b717b4ca86/').prefetch;
    expect(p?.published?.(doc)).toEqual([
      { page: 1, url: 'https://a.hath.network/h/aaa/keystamp=1/01.webp', top: 3 },
      { page: 2, url: 'https://b.hath.network/h/bbb/keystamp=2/02.webp', top: 1847 },
      { page: 3, url: 'https://c.hath.network/h/ccc/keystamp=3/03.webp', top: 3709 },
    ]);
    // The trailing number is the original filename, not the page — page 3 here
    // happens to agree, and page 5 of another gallery ended in `1.webp`. The id
    // is the only honest source, and it is the one used.
    expect(p?.published?.(doc)?.map((x) => x.page)).toEqual([1, 2, 3]);
  });

  it('counts the book from the placeholders, which are all there from the start', () => {
    const p = at('https://e-hentai.org/mpv/4123216/b717b4ca86/').prefetch;
    expect(p?.total?.(docOf({ '.mimg': new Array(26).fill({}) }))).toBe(26);
    // `/s/` has neither placeholders nor a window, so both answers are "nothing".
    expect(p?.total?.(docOf({}))).toBe(null);
    expect(p?.published?.(docOf({}))).toEqual([]);
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
    expect(p?.imageUrl?.('https://i1.nhentai.net/galleries/4121283/7.webp', 1)).toBe(
      'https://i1.nhentai.net/galleries/4121283/8.webp',
    );
    // Older galleries are .jpg; the extension is carried over, not assumed.
    expect(p?.imageUrl?.('https://i3.nhentai.net/galleries/696599/1.jpg', 5)).toBe(
      'https://i3.nhentai.net/galleries/696599/6.jpg',
    );
  });

  it('reads the length of the book off the counter already on the page', () => {
    const p = at('https://nhentai.net/g/673062/7/').prefetch;
    expect(p?.total?.(docWith('34'))).toBe(34);
    expect(p?.total?.(docWith(' 34 '))).toBe(34);
    // No counter, or nonsense in it, means "unknown" — not "guess forever".
    expect(p?.total?.(docWith(null))).toBe(null);
    expect(p?.total?.(docWith('lots'))).toBe(null);
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
