import type { ContentToSw, JobSource, Request } from './messages';

/**
 * Who may say what to the worker, and what a well-formed message looks like.
 *
 * Web pages cannot message us at all (no `externally_connectable`), so the
 * threat this answers is a content script running inside a hostile page — it
 * lives in every tab the browser opens. Such a script may ask for the redacted
 * page settings and run jobs for its own tab; everything that spends quota on
 * the reader's behalf outside a page, reads diagnostics or changes state
 * (TEST_KEY, CACHE_CLEAR, CLEAR_KEY_STATUS, DIAGNOSE, TRANSLATE_VISIBLE, ...) is for the
 * extension's own pages only.
 *
 * Pure, so the rules are tested without a browser. The structural sender type
 * is the subset of chrome.runtime.MessageSender that the rules read.
 */
export interface SenderLike {
  id?: string | undefined;
  url?: string | undefined;
  tab?: { id?: number | undefined } | undefined;
}

export interface ExtensionIdentity {
  /** chrome.runtime.id */
  id: string;
  /** chrome.runtime.getURL(''), e.g. `chrome-extension://<id>/` */
  origin: string;
}

/**
 * Popup, options, offscreen document or the worker itself.
 *
 * Decided by the sender's URL, which the browser sets from the frame that sent
 * the message and a script cannot choose: our pages live at the extension
 * origin, while a content script's sender URL is the web page it runs in.
 * Deliberately *not* "has no tab": the Options page opens in a tab
 * (`open_in_tab`), so it has one, and requiring its absence would lock the
 * reader out of Diagnostics and the key test.
 */
export function isExtensionPage(sender: SenderLike | undefined, self: ExtensionIdentity): boolean {
  return (
    !!sender &&
    sender.id === self.id &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(self.origin)
  );
}

/** A content script of ours, in some web page's tab. */
export function isOwnContentScript(sender: SenderLike | undefined, self: ExtensionIdentity): boolean {
  return (
    !!sender &&
    sender.id === self.id &&
    sender.tab !== undefined &&
    isTabId(sender.tab.id) &&
    !isExtensionPage(sender, self)
  );
}

/** The only one-shot requests a content script needs. */
const TAB_REQUESTS: ReadonlySet<string> = new Set<Request['t']>(['GET_PAGE_SETTINGS', 'PING']);

/** May this sender make this (already parsed) request? */
export function mayRequest(req: Request, sender: SenderLike | undefined, self: ExtensionIdentity): boolean {
  if (isExtensionPage(sender, self)) return true;
  return isOwnContentScript(sender, self) && TAB_REQUESTS.has(req.t);
}

/* ---------------- shapes ---------------- */

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optBool = (v: unknown) => v === undefined || typeof v === 'boolean';

export function isTabId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * Schemes a job may name as its image source.
 *
 * The worker fetches http(s) itself, with the reader's cookies, from a context
 * that ignores CORS. A content script choosing that URL is therefore choosing
 * what the worker fetches — which is the feature for a manga CDN, and must not
 * stretch to `file:`, `chrome:` or the extension's own origin. `blob:` and
 * `data:` are only ever read by the content script itself, and are accepted so
 * the job can carry the URL it came from.
 */
const JOB_URL_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'data:', 'blob:']);

export function isAllowedJobUrl(url: string): boolean {
  try {
    return JOB_URL_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Only these are fetched by the worker. */
export function isWorkerFetchable(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

function isImageRef(v: unknown): boolean {
  return (
    isObj(v) &&
    isStr(v.hash) &&
    v.hash !== '' &&
    isNum(v.bytes) &&
    (v.inlineBase64 === undefined || isStr(v.inlineBase64))
  );
}

export function isJobSource(v: unknown): v is JobSource {
  if (!isObj(v)) return false;
  if (!isStr(v.elementKey) || !isStr(v.pageUrl)) return false;
  if (!(v.url === null || (isStr(v.url) && isAllowedJobUrl(v.url)))) return false;
  if (!(v.setKey === null || isStr(v.setKey))) return false;
  if (!isObj(v.natural) || !isNum(v.natural.w) || !isNum(v.natural.h)) return false;
  if (v.image !== undefined && !isImageRef(v.image)) return false;
  if (v.distance !== undefined && !isNum(v.distance)) return false;
  return optBool(v.force) && optBool(v.prefetch) && optBool(v.manual) && optBool(v.reading);
}

/** A port message from a content script, or null if it is not one. */
export function parsePortMessage(raw: unknown): ContentToSw | null {
  if (!isObj(raw) || !isStr(raw.jobId)) return null;
  if (raw.t === 'CANCEL') return { t: 'CANCEL', jobId: raw.jobId };
  if (raw.t === 'RUN' && isJobSource(raw.source)) return { t: 'RUN', jobId: raw.jobId, source: raw.source };
  return null;
}

const CACHE_WHICH: ReadonlySet<unknown> = new Set(['all', 'ocr', 'translation']);

/** A one-shot request, with the fields that matter checked, or null. */
export function parseRequest(raw: unknown): Request | null {
  if (!isObj(raw) || !isStr(raw.t)) return null;
  switch (raw.t) {
    case 'PING':
    case 'PREWARM':
    case 'DIAGNOSE':
    case 'CACHE_STATS':
    case 'GET_PAGE_SETTINGS':
      return { t: raw.t };
    case 'TEST_KEY':
      return isStr(raw.apiKey) && isStr(raw.model)
        ? { t: 'TEST_KEY', apiKey: raw.apiKey, model: raw.model }
        : null;
    case 'CACHE_CLEAR':
      return CACHE_WHICH.has(raw.which)
        ? { t: 'CACHE_CLEAR', which: raw.which as 'all' | 'ocr' | 'translation' }
        : null;
    case 'CLEAR_KEY_STATUS':
      return isStr(raw.id) && raw.id !== '' ? { t: 'CLEAR_KEY_STATUS', id: raw.id } : null;
    case 'TRANSLATE_VISIBLE':
      return isTabId(raw.tabId) ? { t: 'TRANSLATE_VISIBLE', tabId: raw.tabId } : null;
    default:
      return null;
  }
}

/**
 * The offscreen document answers the worker and nobody else.
 *
 * No tab is the test that matters — a content script always has one — plus our
 * own id. The URL is checked when present but not required, so a worker whose
 * sender record omits it cannot silently stop detection everywhere.
 */
export function isOffscreenCaller(sender: SenderLike | undefined, self: ExtensionIdentity): boolean {
  return (
    !!sender &&
    sender.id === self.id &&
    sender.tab === undefined &&
    (sender.url === undefined || sender.url.startsWith(self.origin))
  );
}
