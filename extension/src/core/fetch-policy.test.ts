import { describe, expect, it } from 'vitest';
import { fetchDecision, isPrivateHost, mayReach, siteOf } from './fetch-policy';

const host = (u: string) => new URL(u).hostname;

describe('isPrivateHost', () => {
  it.each([
    'http://localhost/x.png',
    'http://app.localhost/x.png',
    'http://127.0.0.1/x.png',
    'http://127.1.2.3/x.png',
    'http://2130706433/x.png', // decimal 127.0.0.1, normalised by URL
    'http://0x7f000001/x.png',
    'http://10.0.0.5/x.png',
    'http://172.16.0.1/x.png',
    'http://172.31.255.255/x.png',
    'http://192.168.1.1/x.png',
    'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.1/x.png',
    'http://0.0.0.0/x.png',
    'http://[::1]/x.png',
    'http://[::ffff:127.0.0.1]/x.png',
    'http://[fd12:3456::1]/x.png',
    'http://[fe80::1]/x.png',
    'http://nas.local/x.png',
    'http://router.home.arpa/x.png',
  ])('%s is private', (u) => {
    expect(isPrivateHost(host(u))).toBe(true);
  });

  it.each([
    'https://uploads.mangadex.org/x.png',
    'https://172.32.0.1/x.png',
    'https://172.15.0.1/x.png',
    'https://8.8.8.8/x.png',
    'https://[2001:4860:4860::8888]/x.png',
    'https://[::ffff:8.8.8.8]/x.png',
    'https://localhost.example.com/x.png',
  ])('%s is public', (u) => {
    expect(isPrivateHost(host(u))).toBe(false);
  });
});

describe('siteOf', () => {
  it.each([
    ['s.exhentai.org', 'exhentai.org'],
    ['uploads.mangadex.org', 'mangadex.org'],
    ['mangadex.org', 'mangadex.org'],
    ['a.b.example.co.jp', 'example.co.jp'],
    ['img.example.co.uk', 'example.co.uk'],
    ['cdn.hath.network', 'hath.network'],
    ['192.168.1.4', '192.168.1.4'],
  ])('%s -> %s', (h, site) => {
    expect(siteOf(h)).toBe(site);
  });
});

describe('fetchDecision', () => {
  const page = 'https://reader.example.com/chapter/1';

  it('refuses anything but http(s)', () => {
    for (const u of ['file:///C:/x.png', 'chrome://settings', 'javascript:alert(1)', 'not a url']) {
      expect(fetchDecision(u, page).allowed).toBe(false);
    }
  });

  it('refuses a private host for a public page', () => {
    expect(fetchDecision('http://192.168.1.1/admin', page)).toEqual({
      allowed: false,
      reason: 'private-network host for a public page',
    });
    expect(fetchDecision('http://localhost:8102/x.png', page).allowed).toBe(false);
  });

  it('refuses a private host when the page is unknown', () => {
    expect(fetchDecision('http://127.0.0.1/x.png', undefined).allowed).toBe(false);
  });

  it('allows a private host for a page on a private network (self-hosted reader)', () => {
    expect(fetchDecision('http://192.168.1.20:8080/p/1.jpg', 'http://192.168.1.20:8080/read')).toEqual({
      allowed: true,
      credentials: 'include',
    });
    expect(fetchDecision('http://nas.local/p/1.jpg', 'http://kavita.local/read').allowed).toBe(true);
  });

  it('sends cookies only to the page’s own site', () => {
    expect(fetchDecision('https://img.example.com/1.jpg', page)).toEqual({ allowed: true, credentials: 'include' });
    expect(fetchDecision('https://cdn.other-site.net/1.jpg', page)).toEqual({ allowed: true, credentials: 'omit' });
    expect(fetchDecision('https://img.example.com/1.jpg', undefined)).toEqual({ allowed: true, credentials: 'omit' });
  });
});

describe('mayReach', () => {
  it('blocks a redirect from a public page into the LAN', () => {
    expect(mayReach('192.168.0.1', 'reader.example.com')).toBe(false);
    expect(mayReach('cdn.example.net', 'reader.example.com')).toBe(true);
    expect(mayReach('10.0.0.2', '10.0.0.3')).toBe(true);
  });
});
