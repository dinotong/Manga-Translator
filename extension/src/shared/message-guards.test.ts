import { describe, expect, it } from 'vitest';
import {
  isAllowedJobUrl,
  isExtensionPage,
  isOffscreenCaller,
  isOwnContentScript,
  isWorkerFetchable,
  mayRequest,
  parsePortMessage,
  parseRequest,
} from './message-guards';

const self = { id: 'abc', origin: 'chrome-extension://abc/' };
const popup = { id: 'abc', url: 'chrome-extension://abc/popup.html' };
// Options opens in a tab (open_in_tab), so it carries one.
const options = { id: 'abc', url: 'chrome-extension://abc/options.html', tab: { id: 7 } };
const worker = { id: 'abc', url: 'chrome-extension://abc/background.js' };
const content = { id: 'abc', url: 'https://evil.example/page', tab: { id: 3 } };
const otherExt = { id: 'zzz', url: 'chrome-extension://zzz/x.html' };

describe('senders', () => {
  it('recognises our pages, including the options tab', () => {
    expect(isExtensionPage(popup, self)).toBe(true);
    expect(isExtensionPage(options, self)).toBe(true);
    expect(isExtensionPage(content, self)).toBe(false);
    expect(isExtensionPage(otherExt, self)).toBe(false);
    expect(isExtensionPage(undefined, self)).toBe(false);
  });

  it('recognises a content script only in a web page tab', () => {
    expect(isOwnContentScript(content, self)).toBe(true);
    expect(isOwnContentScript(options, self)).toBe(false);
    expect(isOwnContentScript(popup, self)).toBe(false);
    expect(isOwnContentScript({ ...content, id: 'zzz' }, self)).toBe(false);
    expect(isOwnContentScript({ ...content, tab: { id: -1 } }, self)).toBe(false);
  });

  it('lets only the extension itself, with no tab, drive the offscreen document', () => {
    expect(isOffscreenCaller(worker, self)).toBe(true);
    expect(isOffscreenCaller({ id: 'abc' }, self)).toBe(true);
    expect(isOffscreenCaller(content, self)).toBe(false);
    expect(isOffscreenCaller(otherExt, self)).toBe(false);
    expect(isOffscreenCaller({ id: 'abc', url: 'https://evil.example/' }, self)).toBe(false);
  });
});

describe('mayRequest', () => {
  const admin = [
    { t: 'TEST_KEY', apiKey: 'k', model: 'm' },
    { t: 'CACHE_CLEAR', which: 'all' },
    { t: 'DIAGNOSE' },
    { t: 'TRANSLATE_VISIBLE', tabId: 1 },
    { t: 'PREWARM' },
    { t: 'CACHE_STATS' },
  ] as const;

  it('refuses every admin request from a content script', () => {
    for (const r of admin) expect(mayRequest(r, content, self), r.t).toBe(false);
  });

  it('allows them from the popup and the options tab', () => {
    for (const r of admin) {
      expect(mayRequest(r, popup, self), r.t).toBe(true);
      expect(mayRequest(r, options, self), r.t).toBe(true);
    }
  });

  it('lets a content script ask for its settings view, and nobody unknown anything', () => {
    expect(mayRequest({ t: 'GET_PAGE_SETTINGS' }, content, self)).toBe(true);
    expect(mayRequest({ t: 'GET_PAGE_SETTINGS' }, otherExt, self)).toBe(false);
    expect(mayRequest({ t: 'GET_PAGE_SETTINGS' }, undefined, self)).toBe(false);
  });
});

describe('parseRequest', () => {
  it('accepts the well-formed shapes', () => {
    expect(parseRequest({ t: 'TRANSLATE_VISIBLE', tabId: 4 })).toEqual({ t: 'TRANSLATE_VISIBLE', tabId: 4 });
    expect(parseRequest({ t: 'CACHE_CLEAR', which: 'ocr' })).toEqual({ t: 'CACHE_CLEAR', which: 'ocr' });
    expect(parseRequest({ t: 'TEST_KEY', apiKey: 'a', model: 'b', extra: 1 })).toEqual({
      t: 'TEST_KEY',
      apiKey: 'a',
      model: 'b',
    });
  });

  it('rejects bad fields and unknown types', () => {
    expect(parseRequest({ t: 'TRANSLATE_VISIBLE', tabId: '4' })).toBeNull();
    expect(parseRequest({ t: 'TRANSLATE_VISIBLE', tabId: 1.5 })).toBeNull();
    expect(parseRequest({ t: 'CACHE_CLEAR', which: 'everything' })).toBeNull();
    expect(parseRequest({ t: 'TEST_KEY', apiKey: 1, model: 'b' })).toBeNull();
    expect(parseRequest({ t: 'SET_SETTINGS' })).toBeNull();
    expect(parseRequest(null)).toBeNull();
    expect(parseRequest('PING')).toBeNull();
  });
});

describe('job sources', () => {
  const source = {
    elementKey: 'e1',
    url: 'https://cdn.example/1.jpg',
    natural: { w: 100, h: 200 },
    pageUrl: 'https://site.example/g/1/',
    setKey: null,
  };

  it('accepts a normal job and a cancel', () => {
    expect(parsePortMessage({ t: 'RUN', jobId: 'j', source })).toEqual({ t: 'RUN', jobId: 'j', source });
    expect(parsePortMessage({ t: 'RUN', jobId: 'j', source: { ...source, url: null } })).not.toBeNull();
    expect(parsePortMessage({ t: 'CANCEL', jobId: 'j' })).toEqual({ t: 'CANCEL', jobId: 'j' });
  });

  it('refuses a URL the worker must never fetch with the reader’s cookies', () => {
    for (const url of [
      'file:///C:/Users/x/secret.txt',
      'chrome://settings',
      'chrome-extension://abc/options.html',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(parsePortMessage({ t: 'RUN', jobId: 'j', source: { ...source, url } }), url).toBeNull();
    }
  });

  it('refuses malformed sources', () => {
    expect(parsePortMessage({ t: 'RUN', jobId: 'j' })).toBeNull();
    expect(parsePortMessage({ t: 'RUN', jobId: 1, source })).toBeNull();
    expect(parsePortMessage({ t: 'RUN', jobId: 'j', source: { ...source, natural: null } })).toBeNull();
    expect(parsePortMessage({ t: 'RUN', jobId: 'j', source: { ...source, image: { hash: '' } } })).toBeNull();
    expect(parsePortMessage({ t: 'RUN', jobId: 'j', source: { ...source, force: 'yes' } })).toBeNull();
  });

  it('separates what a job may name from what the worker will fetch', () => {
    expect(isAllowedJobUrl('blob:https://mangadex.org/123')).toBe(true);
    expect(isAllowedJobUrl('data:image/png;base64,AA')).toBe(true);
    expect(isWorkerFetchable('blob:https://mangadex.org/123')).toBe(false);
    expect(isWorkerFetchable('data:image/png;base64,AA')).toBe(false);
    expect(isWorkerFetchable('https://cdn.example/1.jpg')).toBe(true);
    expect(isWorkerFetchable('http://cdn.example/1.jpg')).toBe(true);
  });
});
