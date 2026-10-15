/**
 * Gemini quota bookkeeping: which key to use, and what a 429 actually meant.
 *
 * The whole reason this file exists is that Gemini returns **429 for two
 * completely different failures**, and treating them the same destroys the
 * feature it is supposed to support. Captured verbatim from the live API:
 *
 * ```json
 * { "error": { "code": 429, "status": "RESOURCE_EXHAUSTED",
 *   "message": "... Quota exceeded for metric:
 *      generativelanguage.googleapis.com/generate_content_free_tier_requests,
 *      limit: 15, model: gemini-3.5-flash-lite\nPlease retry in 30.36201667s.",
 *   "details": [
 *     { "@type": "...QuotaFailure", "violations": [{
 *         "quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
 *         "quotaValue": "15" }] },
 *     { "@type": "...RetryInfo", "retryDelay": "30s" } ] } }
 * ```
 *
 * `quotaId` is the discriminator. A per-minute violation means *wait and retry
 * the same key*; rotating on it would walk through every key the user owns
 * within a few seconds of fast reading and leave them with nothing — a far worse
 * outcome than the 30 second pause it was trying to avoid. Only a `PerDay`
 * violation may advance to the next key.
 *
 * Everything here is pure so it can be tested without a network or a browser.
 */

/**
 * Gemini's free-tier daily counter rolls over at midnight **Pacific**, not at
 * the user's local midnight. A Thai reader is UTC+7, i.e. 14–15 hours ahead, so
 * assuming the local day would tell them a key is free for most of an afternoon
 * during which it is still exhausted.
 */
export const QUOTA_TIMEZONE = 'America/Los_Angeles';

/**
 * How long after Pacific midnight we keep believing a key is still exhausted.
 *
 * Google's counters do not reset on the same millisecond the calendar does, and
 * the two mistakes are not symmetrical: saying "available" too early sends a
 * request that fails and re-marks the key, while saying "exhausted" a few
 * minutes too long costs nothing but a later start.
 */
export const RESET_GRACE_MS = 5 * 60_000;

const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ */
/* Classifying a 429                                                   */
/* ------------------------------------------------------------------ */

export type QuotaScope = 'per-minute' | 'per-day' | 'unknown';

export interface QuotaVerdict {
  scope: QuotaScope;
  /** From RetryInfo, when the API supplied one. */
  retryAfterMs: number | null;
  quotaId: string | null;
  /** The numeric limit that was hit (15 for RPM, 1000 for RPD on the free tier). */
  limit: number | null;
}

interface QuotaBody {
  error?: {
    message?: string;
    details?: {
      '@type'?: string;
      retryDelay?: string;
      violations?: { quotaId?: string; quotaValue?: string; quotaMetric?: string }[];
    }[];
  };
}

/**
 * Decide what a 429 body was complaining about.
 *
 * Unrecognised bodies deliberately return `'unknown'`, and every caller must
 * treat unknown as per-minute. Guessing "per day" on something we cannot read
 * is the expensive direction: it burns a key permanently for the rest of the
 * day on the strength of a string we did not understand.
 */
export function classifyQuotaError(body: string): QuotaVerdict {
  let parsed: QuotaBody | null = null;
  try {
    parsed = JSON.parse(body) as QuotaBody;
  } catch {
    parsed = null;
  }

  const details = parsed?.error?.details ?? [];
  const violation = details.flatMap((d) => d.violations ?? []).find((v) => v.quotaId);
  const retry = details.find((d) => typeof d.retryDelay === 'string')?.retryDelay;
  const message = parsed?.error?.message ?? body;

  const quotaId = violation?.quotaId ?? null;
  const limit = toNumber(violation?.quotaValue) ?? limitFromMessage(message);

  return {
    scope: scopeOf(quotaId, message),
    retryAfterMs: parseRetryDelay(retry) ?? retryFromMessage(message),
    quotaId,
    limit,
  };
}

function scopeOf(quotaId: string | null, message: string): QuotaScope {
  // quotaId is the authoritative signal; the message is only a fallback for a
  // body shape we have not seen.
  if (quotaId) {
    if (/PerDay/i.test(quotaId)) return 'per-day';
    if (/PerMinute/i.test(quotaId)) return 'per-minute';
  }
  if (/per\s*day|requests per day|\bRPD\b/i.test(message)) return 'per-day';
  if (/per\s*minute|requests per minute|\bRPM\b/i.test(message)) return 'per-minute';
  return 'unknown';
}

/** `"30s"`, `"30.36201667s"`, `"90.5s"` -> milliseconds. */
export function parseRetryDelay(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const m = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(raw.trim());
  if (!m) return null;
  const seconds = Number(m[1]);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

/** The message carries the same delay in prose: "Please retry in 30.36201667s." */
function retryFromMessage(message: string): number | null {
  const m = /retry in ([0-9]+(?:\.[0-9]+)?)s/i.exec(message);
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

function limitFromMessage(message: string): number | null {
  const m = /limit:\s*([0-9]+)/i.exec(message);
  return m ? Number(m[1]) : null;
}

function toNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Wait before retrying the *same* key after a per-minute limit. */
export function backoffMs(verdict: QuotaVerdict, attempt: number): number {
  // A second of headroom over what the API asked for: its own delay is computed
  // against a sliding window and coming back at the exact edge is a coin flip.
  if (verdict.retryAfterMs !== null) return verdict.retryAfterMs + 1_000;
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt));
}

/* ------------------------------------------------------------------ */
/* The Pacific quota day                                               */
/* ------------------------------------------------------------------ */

/** `YYYY-MM-DD` in Pacific time. Sorts lexicographically, which callers rely on. */
export function quotaDay(now: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: QUOTA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Offset of the quota timezone at a given instant, DST included.
 *
 * Formatting the instant in Pacific and then reading those wall-clock fields
 * back as if they were UTC gives the offset without hardcoding -8 or -7, which
 * would be wrong for half of every year.
 */
function tzOffsetMs(at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: QUOTA_TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const f = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(f('year'), f('month') - 1, f('day'), f('hour'), f('minute'), f('second'));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** Milliseconds elapsed since the most recent Pacific midnight. */
export function msSinceQuotaMidnight(now: number): number {
  const wall = now + tzOffsetMs(now);
  return wall - Math.floor(wall / DAY_MS) * DAY_MS;
}

/** Epoch ms of the next Pacific midnight — when the daily counters roll over. */
export function nextQuotaResetAt(now: number): number {
  const offset = tzOffsetMs(now);
  const wall = now + offset;
  const nextWall = Math.floor(wall / DAY_MS) * DAY_MS + DAY_MS;
  // Re-read the offset near the target so a DST boundary between now and then
  // does not move the answer by an hour.
  return nextWall - tzOffsetMs(nextWall - offset);
}

/* ------------------------------------------------------------------ */
/* Keys and their state                                                */
/* ------------------------------------------------------------------ */

export interface ApiKeyEntry {
  /** Stable across edits and reordering; what KeyStatuses is keyed by. */
  id: string;
  /** The user's own name for it, so "which key is that?" has an answer. */
  label: string;
  key: string;
}

export interface KeyStatus {
  /** Pacific quota day on which the *daily* quota ran out. */
  exhaustedOn?: string;
  /** Why the provider rejected the key itself. Not a quota problem. */
  invalid?: string;
  /** When either of the above was recorded, for display only. */
  at?: number;
}

export type KeyStatuses = Record<string, KeyStatus>;

export type KeyState = 'active' | 'standby' | 'exhausted' | 'invalid' | 'empty';

/** A key that cannot be used at all, whatever the quota says. */
export function isBlank(entry: ApiKeyEntry): boolean {
  return entry.key.trim().length === 0;
}

export function isInvalid(status: KeyStatus | undefined): boolean {
  return Boolean(status?.invalid);
}

/** Is this key still out of daily quota right now? */
export function isExhausted(status: KeyStatus | undefined, now: number): boolean {
  const on = status?.exhaustedOn;
  if (!on) return false;

  const today = quotaDay(now);
  // `on > today` means the clock moved backwards (timezone change, NTP jump).
  // Staying exhausted is the conservative reading.
  if (on >= today) return true;

  return msSinceQuotaMidnight(now) < RESET_GRACE_MS;
}

export function isUsable(entry: ApiKeyEntry, status: KeyStatus | undefined, now: number): boolean {
  return !isBlank(entry) && !isInvalid(status) && !isExhausted(status, now);
}

/**
 * The key to use right now: the first usable one, in the order the user chose.
 *
 * Order is the entire feature. "Use the first, fall through when it is spent"
 * is what makes a spare key a spare rather than a load balancer.
 */
export function pickKey(
  keys: readonly ApiKeyEntry[],
  statuses: KeyStatuses,
  now: number,
): ApiKeyEntry | null {
  return keys.find((k) => isUsable(k, statuses[k.id], now)) ?? null;
}

/** Every key with the state the UI should draw. */
export function keyReport(
  keys: readonly ApiKeyEntry[],
  statuses: KeyStatuses,
  now: number,
): { entry: ApiKeyEntry; state: KeyState; status: KeyStatus | undefined }[] {
  const active = pickKey(keys, statuses, now);
  return keys.map((entry) => {
    const status = statuses[entry.id];
    const state: KeyState = isBlank(entry)
      ? 'empty'
      : isInvalid(status)
        ? 'invalid'
        : isExhausted(status, now)
          ? 'exhausted'
          : entry.id === active?.id
            ? 'active'
            : 'standby';
    return { entry, state, status };
  });
}

/** True when there is at least one key configured but none can be used. */
export function allSpent(keys: readonly ApiKeyEntry[], statuses: KeyStatuses, now: number): boolean {
  return keys.some((k) => !isBlank(k)) && pickKey(keys, statuses, now) === null;
}

export function withExhausted(statuses: KeyStatuses, id: string, now: number): KeyStatuses {
  return { ...statuses, [id]: { ...statuses[id], exhaustedOn: quotaDay(now), at: now } };
}

export function withInvalid(
  statuses: KeyStatuses,
  id: string,
  reason: string,
  now: number,
): KeyStatuses {
  return { ...statuses, [id]: { ...statuses[id], invalid: reason || 'ถูกปฏิเสธ', at: now } };
}

/** Forget everything we know about a key. Used when its text is edited or it tests clean. */
export function withCleared(statuses: KeyStatuses, id: string): KeyStatuses {
  const next = { ...statuses };
  delete next[id];
  return next;
}

/**
 * Drop entries that no longer mean anything: keys that were deleted, and daily
 * exhaustion from a day that has already rolled over.
 *
 * An `invalid` mark is *not* pruned by time — a revoked key does not come back
 * tomorrow, and the user clears it by editing or testing the key.
 */
export function pruneStatuses(
  statuses: KeyStatuses,
  keys: readonly ApiKeyEntry[],
  now: number,
): KeyStatuses {
  const live = new Set(keys.map((k) => k.id));
  const next: KeyStatuses = {};
  for (const [id, status] of Object.entries(statuses)) {
    if (!live.has(id)) continue;
    const keep: KeyStatus = { ...status };
    if (keep.exhaustedOn && !isExhausted(keep, now)) delete keep.exhaustedOn;
    if (keep.exhaustedOn || keep.invalid) next[id] = keep;
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Editing the list                                                    */
/* ------------------------------------------------------------------ */

export function moveKey(keys: readonly ApiKeyEntry[], index: number, delta: number): ApiKeyEntry[] {
  const to = index + delta;
  if (index < 0 || index >= keys.length || to < 0 || to >= keys.length) return [...keys];
  const next = [...keys];
  const [moved] = next.splice(index, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}

/** Last 4 characters, for telling two keys apart without showing either of them. */
export function keyFingerprint(key: string): string {
  const trimmed = key.trim();
  return trimmed.length <= 4 ? '••••' : `••••${trimmed.slice(-4)}`;
}
