import { type KeyStatuses, pruneStatuses } from '../core/quota';
import type { ApiKeyEntry } from '../core/quota';

/**
 * Which keys are spent or broken, stored apart from Settings.
 *
 * Deliberately not a field inside Settings: every settings write fans out to
 * `onSettingsChanged`, which messages every open tab and re-runs the model
 * prewarm. Quota bookkeeping changes on a failed request, sometimes several
 * times a minute, and none of those listeners want to hear about it.
 *
 * chrome.storage.local rather than memory because the service worker is torn
 * down constantly — an in-memory record of "this key is spent" would be gone by
 * the next page turn, and the extension would rediscover it by wasting another
 * request.
 */
const KEY = 'geminiKeyStatuses';

export async function loadKeyStatuses(): Promise<KeyStatuses> {
  const got = await chrome.storage.local.get(KEY);
  const raw = got[KEY];
  return raw && typeof raw === 'object' ? (raw as KeyStatuses) : {};
}

export async function saveKeyStatuses(next: KeyStatuses): Promise<void> {
  await chrome.storage.local.set({ [KEY]: next });
}

/** Read-modify-write. Not atomic across contexts, but only the worker writes. */
export async function updateKeyStatuses(
  fn: (current: KeyStatuses) => KeyStatuses,
): Promise<KeyStatuses> {
  const next = fn(await loadKeyStatuses());
  await saveKeyStatuses(next);
  return next;
}

/** Drop what has expired or belongs to a deleted key. Safe to call on every load. */
export async function tidyKeyStatuses(
  keys: readonly ApiKeyEntry[],
  now = Date.now(),
): Promise<KeyStatuses> {
  const current = await loadKeyStatuses();
  const next = pruneStatuses(current, keys, now);
  if (JSON.stringify(next) !== JSON.stringify(current)) await saveKeyStatuses(next);
  return next;
}

export function onKeyStatusesChanged(cb: (s: KeyStatuses) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName,
  ) => {
    if (area !== 'local' || !changes[KEY]) return;
    const raw = changes[KEY].newValue;
    cb(raw && typeof raw === 'object' ? (raw as KeyStatuses) : {});
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
