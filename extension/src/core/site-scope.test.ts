import { describe, expect, it } from 'vitest';
import { isAutoOn, normalizeHost, normalizeSiteList, siteKey, withAutoSite } from './site-scope';

describe('normalizeHost', () => {
  it('lowercases and trims', () => {
    expect(normalizeHost('  IMHentai.XXX ')).toBe('imhentai.xxx');
  });

  it('treats www.x and x as one site', () => {
    expect(normalizeHost('www.mangadex.org')).toBe('mangadex.org');
    expect(normalizeHost('mangadex.org')).toBe('mangadex.org');
  });

  it('leaves other subdomains alone — they are different sites', () => {
    expect(normalizeHost('m.imhentai.xxx')).toBe('m.imhentai.xxx');
    expect(normalizeHost('www2.example.com')).toBe('www2.example.com');
  });

  it('does not eat a host that is only "www.something"', () => {
    // Stripping blindly would turn this into the TLD `com`.
    expect(normalizeHost('www.com')).toBe('www.com');
  });

  it('drops the trailing root dot', () => {
    expect(normalizeHost('mangadex.org.')).toBe('mangadex.org');
  });

  it('keeps localhost and IP literals as they are', () => {
    expect(normalizeHost('localhost')).toBe('localhost');
    expect(normalizeHost('127.0.0.1')).toBe('127.0.0.1');
  });
});

describe('siteKey', () => {
  it('ignores the path, query and port — the whole gallery is one site', () => {
    expect(siteKey('https://imhentai.xxx/view/1474885/1/')).toBe('imhentai.xxx');
    expect(siteKey('https://imhentai.xxx/view/1474885/9/?x=1#f')).toBe('imhentai.xxx');
    expect(siteKey('http://localhost:5173/read')).toBe('localhost');
  });

  it('folds www into the bare host', () => {
    expect(siteKey('https://www.mangadex.org/chapter/abc/1')).toBe('mangadex.org');
  });

  it('refuses pages that are not sites the reader can switch on', () => {
    expect(siteKey('chrome://extensions')).toBeNull();
    expect(siteKey('edge://settings')).toBeNull();
    expect(siteKey('about:blank')).toBeNull();
    expect(siteKey('file:///D:/manga/page.html')).toBeNull();
    expect(siteKey('chrome-extension://abcdef/popup.html')).toBeNull();
  });

  it('returns null rather than throwing on rubbish', () => {
    expect(siteKey('not a url')).toBeNull();
    expect(siteKey('')).toBeNull();
  });

  it('accepts a URL object as well as a string', () => {
    expect(siteKey(new URL('https://imhentai.xxx/view/1/1/'))).toBe('imhentai.xxx');
  });
});

describe('isAutoOn — a site nobody enabled is off', () => {
  const on = ['imhentai.xxx'];

  it('runs on the site that was turned on', () => {
    expect(isAutoOn(on, 'imhentai.xxx')).toBe(true);
  });

  it('does not run on a site that was never mentioned', () => {
    expect(isAutoOn(on, 'wikipedia.org')).toBe(false);
    expect(isAutoOn(on, 'mangadex.org')).toBe(false);
  });

  it('is off with an empty list, which is the fresh-install state', () => {
    expect(isAutoOn([], 'imhentai.xxx')).toBe(false);
  });

  it('is off where there is no site at all (chrome:// and friends)', () => {
    expect(isAutoOn(on, null)).toBe(false);
  });

  it('does not match a subdomain of an enabled site', () => {
    // forum.imhentai.xxx is a different page from the reader's point of view,
    // and matching by suffix is how one switch quietly covers a whole company.
    expect(isAutoOn(on, 'forum.imhentai.xxx')).toBe(false);
  });
});

describe('withAutoSite', () => {
  it('adds a site once, however many times it is switched on', () => {
    let list = withAutoSite([], 'imhentai.xxx', true);
    list = withAutoSite(list, 'imhentai.xxx', true);
    expect(list).toEqual(['imhentai.xxx']);
  });

  it('removes the entry rather than storing an explicit off', () => {
    expect(withAutoSite(['a.com', 'b.com'], 'a.com', false)).toEqual(['b.com']);
  });

  it('turning off a site that was never on is a no-op', () => {
    expect(withAutoSite(['a.com'], 'b.com', false)).toEqual(['a.com']);
  });

  it('keeps the order sites were enabled in', () => {
    const list = withAutoSite(withAutoSite([], 'a.com', true), 'b.com', true);
    expect(list).toEqual(['a.com', 'b.com']);
  });

  it('does nothing when there is no site key', () => {
    expect(withAutoSite(['a.com'], null, true)).toEqual(['a.com']);
  });

  it('never mutates the list it was given', () => {
    const before = ['a.com'];
    withAutoSite(before, 'b.com', true);
    expect(before).toEqual(['a.com']);
  });
});

describe('normalizeSiteList', () => {
  it('canonicalises and de-duplicates hand-edited storage', () => {
    expect(normalizeSiteList([' WWW.MangaDex.org ', 'mangadex.org', 'imhentai.xxx'])).toEqual([
      'mangadex.org',
      'imhentai.xxx',
    ]);
  });

  it('drops non-strings and blanks instead of crashing the settings page', () => {
    expect(normalizeSiteList(['a.com', null, 42, '', '   ', undefined])).toEqual(['a.com']);
  });

  it('treats anything that is not a list as no sites at all', () => {
    expect(normalizeSiteList(undefined)).toEqual([]);
    expect(normalizeSiteList(true)).toEqual([]);
    expect(normalizeSiteList('imhentai.xxx')).toEqual([]);
  });
});
