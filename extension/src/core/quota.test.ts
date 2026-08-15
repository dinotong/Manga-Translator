import { describe, expect, it } from 'vitest';
import {
  allSpent,
  type ApiKeyEntry,
  backoffMs,
  classifyQuotaError,
  isExhausted,
  keyFingerprint,
  keyReport,
  type KeyStatuses,
  moveKey,
  msSinceQuotaMidnight,
  nextQuotaResetAt,
  parseRetryDelay,
  pickKey,
  pruneStatuses,
  quotaDay,
  RESET_GRACE_MS,
  withCleared,
  withExhausted,
  withInvalid,
} from './quota';

/**
 * The per-minute 429, captured verbatim from the live API on 2026-08-15 by
 * firing 26 concurrent requests at gemini-flash-lite-latest with one free-tier
 * key. Twelve returned 200 and the rest looked exactly like this.
 */
const REAL_PER_MINUTE = JSON.stringify({
  error: {
    code: 429,
    message:
      'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 15, model: gemini-3.5-flash-lite\nPlease retry in 30.36201667s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.Help',
        links: [{ description: 'Learn more about Gemini API quotas', url: 'https://x' }],
      },
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
            quotaDimensions: { model: 'gemini-3.5-flash-lite', location: 'global' },
            quotaValue: '15',
          },
        ],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' },
    ],
  },
});

/**
 * A second capture, taken independently later the same day by firing 18
 * requests at the same model until three came back 429.
 *
 * Kept alongside the first because it is the evidence that the shape above was
 * observed rather than imagined: same envelope, same `quotaId`, same
 * `quotaValue`, Help detail still first and RetryInfo still last — and a
 * different delay, which is the part that varies and therefore the part no test
 * may hardcode an expectation about beyond "it was read correctly".
 */
const REAL_PER_MINUTE_2 = JSON.stringify({
  error: {
    code: 429,
    message:
      'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 15, model: gemini-3.5-flash-lite\nPlease retry in 57.359612648s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.Help',
        links: [
          {
            description: 'Learn more about Gemini API quotas',
            url: 'https://ai.google.dev/gemini-api/docs/rate-limits',
          },
        ],
      },
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
            quotaDimensions: { location: 'global', model: 'gemini-3.5-flash-lite' },
            quotaValue: '15',
          },
        ],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '57s' },
    ],
  },
});

/**
 * Same envelope, per-day quota id.
 *
 * This one is *constructed*, not captured: reaching it costs 1,000 requests.
 * The id is not invented though — `GenerateRequestsPerDayPerProjectPerModel-FreeTier`
 * is the string other people have reported receiving (google-gemini/gemini-cli
 * issue #9248). If Google ever renames it, `scopeOf` still catches anything
 * containing "PerDay", and an unrecognised body falls back to per-minute, which
 * is the cheap direction to be wrong in.
 */
const PER_DAY = JSON.stringify({
  error: {
    code: 429,
    message:
      '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 1000, model: gemini-flash-lite',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
            quotaValue: '1000',
          },
        ],
      },
    ],
  },
});

describe('classifyQuotaError', () => {
  it('reads the real per-minute 429 as per-minute, with its retry delay', () => {
    const v = classifyQuotaError(REAL_PER_MINUTE);
    expect(v.scope).toBe('per-minute');
    expect(v.retryAfterMs).toBe(30_000);
    expect(v.limit).toBe(15);
    expect(v.quotaId).toBe('GenerateRequestsPerMinutePerProjectPerModel-FreeTier');
  });

  it('reads a second, independently captured per-minute 429 the same way', () => {
    // The two live bodies differ only in the retry delay, so anything that
    // classified one and not the other would be keying off the wrong field.
    const v = classifyQuotaError(REAL_PER_MINUTE_2);
    expect(v.scope).toBe('per-minute');
    expect(v.limit).toBe(15);
    expect(v.quotaId).toBe('GenerateRequestsPerMinutePerProjectPerModel-FreeTier');
    expect(v.retryAfterMs).toBe(57_000);
  });

  it('never rotates a key on a per-minute body, however it is worded', () => {
    // The whole point of the file: a fast reader trips 15 RPM constantly, and a
    // ring that advanced on it would walk through every key they own in
    // seconds. Only a per-day verdict may advance.
    for (const body of [REAL_PER_MINUTE, REAL_PER_MINUTE_2]) {
      expect(classifyQuotaError(body).scope).not.toBe('per-day');
    }
  });

  it('reads a per-day quotaId as per-day', () => {
    const v = classifyQuotaError(PER_DAY);
    expect(v.scope).toBe('per-day');
    expect(v.limit).toBe(1000);
  });

  it('falls back to the prose when there is no QuotaFailure detail', () => {
    expect(classifyQuotaError('{"error":{"message":"requests per day exceeded"}}').scope).toBe(
      'per-day',
    );
    expect(classifyQuotaError('{"error":{"message":"limit per minute"}}').scope).toBe('per-minute');
  });

  it('returns unknown rather than guessing, on a body it cannot read', () => {
    // Unknown must never be read as per-day by a caller: that would spend a key
    // for the rest of the day on the strength of a string we did not parse.
    expect(classifyQuotaError('<html>502 Bad Gateway</html>').scope).toBe('unknown');
    expect(classifyQuotaError('').scope).toBe('unknown');
    expect(classifyQuotaError('{"error":{"code":429}}').scope).toBe('unknown');
  });

  it('still finds the delay when RetryInfo is missing but the prose has it', () => {
    const v = classifyQuotaError('{"error":{"message":"Please retry in 12.5s."}}');
    expect(v.retryAfterMs).toBe(12_500);
  });
});

describe('parseRetryDelay', () => {
  it('accepts the fractional-second form Google actually sends', () => {
    expect(parseRetryDelay('30s')).toBe(30_000);
    expect(parseRetryDelay('30.36201667s')).toBe(30_362);
  });

  it('rejects anything else instead of producing NaN', () => {
    expect(parseRetryDelay('30')).toBeNull();
    expect(parseRetryDelay('soon')).toBeNull();
    expect(parseRetryDelay(undefined)).toBeNull();
  });
});

describe('backoffMs', () => {
  it('honours the API delay with a second of headroom', () => {
    expect(backoffMs(classifyQuotaError(REAL_PER_MINUTE), 0)).toBe(31_000);
  });

  it('backs off exponentially when no delay was supplied, capped at a minute', () => {
    const blind = classifyQuotaError('{}');
    expect(backoffMs(blind, 0)).toBe(2_000);
    expect(backoffMs(blind, 1)).toBe(4_000);
    expect(backoffMs(blind, 9)).toBe(60_000);
  });
});

/* ------------------------------------------------------------------ */

/** 2026-08-15 09:00 Bangkok = 2026-08-14 19:00 Pacific — a different date. */
const BKK_MORNING = Date.UTC(2026, 7, 15, 2, 0, 0);

describe('quotaDay', () => {
  it('uses the Pacific date, not UTC and not the local one', () => {
    expect(quotaDay(BKK_MORNING)).toBe('2026-08-14');
    // Four hours later it is well into the 15th in Bangkok, and still the 14th
    // in Pacific — the whole window in which a local-day reading is wrong.
    expect(quotaDay(BKK_MORNING + 4 * 3600_000)).toBe('2026-08-14');
    // 00:30 Pacific on the 15th.
    expect(quotaDay(Date.UTC(2026, 7, 15, 7, 30))).toBe('2026-08-15');
  });

  it('handles both sides of a DST change', () => {
    // 2026-11-01 is the US fall-back date; the offset differs either side of it.
    expect(quotaDay(Date.UTC(2026, 9, 20, 7, 30))).toBe('2026-10-20'); // PDT, UTC-7
    expect(quotaDay(Date.UTC(2026, 10, 20, 7, 30))).toBe('2026-11-19'); // PST, UTC-8
  });
});

describe('nextQuotaResetAt / msSinceQuotaMidnight', () => {
  it('lands on the next Pacific midnight', () => {
    const at = nextQuotaResetAt(BKK_MORNING);
    expect(quotaDay(at)).toBe('2026-08-15');
    expect(msSinceQuotaMidnight(at)).toBe(0);
    expect(at).toBeGreaterThan(BKK_MORNING);
    expect(at - BKK_MORNING).toBeLessThanOrEqual(24 * 3600_000);
  });

  it('measures the day from Pacific midnight, not local midnight', () => {
    expect(msSinceQuotaMidnight(Date.UTC(2026, 7, 15, 7, 0))).toBe(0); // 00:00 PDT
    expect(msSinceQuotaMidnight(Date.UTC(2026, 7, 15, 8, 30))).toBe(90 * 60_000);
  });
});

/* ------------------------------------------------------------------ */

const KEYS: ApiKeyEntry[] = [
  { id: 'a', label: 'หลัก', key: 'AIza-a' },
  { id: 'b', label: 'สำรอง', key: 'AIza-b' },
  { id: 'c', label: 'สำรอง 2', key: 'AIza-c' },
];

/** 10:00 Pacific — comfortably past the reset grace window. */
const MIDDAY = Date.UTC(2026, 7, 15, 17, 0);

describe('isExhausted', () => {
  it('is true for the whole of the Pacific day it happened on', () => {
    const st = { exhaustedOn: quotaDay(MIDDAY) };
    expect(isExhausted(st, MIDDAY)).toBe(true);
    expect(isExhausted(st, MIDDAY + 6 * 3600_000)).toBe(true);
  });

  it('clears once the Pacific day rolls over, after a grace period', () => {
    const st = { exhaustedOn: '2026-08-15' };
    const midnight = Date.UTC(2026, 7, 16, 7, 0); // 00:00 PDT on the 16th
    // Google's counters do not reset to the millisecond, so the minutes right
    // after midnight still report exhausted rather than promising a key that
    // will immediately 429 again.
    expect(isExhausted(st, midnight + 60_000)).toBe(true);
    expect(isExhausted(st, midnight + RESET_GRACE_MS + 1)).toBe(false);
  });

  it('stays exhausted if the clock jumps backwards', () => {
    expect(isExhausted({ exhaustedOn: '2026-09-01' }, MIDDAY)).toBe(true);
  });

  it('is false when nothing was recorded', () => {
    expect(isExhausted(undefined, MIDDAY)).toBe(false);
    expect(isExhausted({ invalid: 'revoked' }, MIDDAY)).toBe(false);
  });
});

describe('pickKey', () => {
  it('uses the first key, in the order the user put them in', () => {
    expect(pickKey(KEYS, {}, MIDDAY)?.id).toBe('a');
  });

  it('falls through to the next one when the first is spent for the day', () => {
    const st = withExhausted({}, 'a', MIDDAY);
    expect(pickKey(KEYS, st, MIDDAY)?.id).toBe('b');
  });

  it('skips an invalid key without treating it as exhausted', () => {
    const st = withInvalid({}, 'a', 'API key not valid', MIDDAY);
    expect(pickKey(KEYS, st, MIDDAY)?.id).toBe('b');
    expect(keyReport(KEYS, st, MIDDAY)[0]?.state).toBe('invalid');
  });

  it('skips a blank entry', () => {
    const keys = [{ id: 'a', label: '', key: '   ' }, ...KEYS.slice(1)];
    expect(pickKey(keys, {}, MIDDAY)?.id).toBe('b');
  });

  it('returns null only when every key is unusable', () => {
    let st: KeyStatuses = {};
    for (const k of KEYS) st = withExhausted(st, k.id, MIDDAY);
    expect(pickKey(KEYS, st, MIDDAY)).toBeNull();
    expect(allSpent(KEYS, st, MIDDAY)).toBe(true);
    // Tomorrow the same state lets the first key back in.
    const tomorrow = MIDDAY + 24 * 3600_000;
    expect(pickKey(KEYS, st, tomorrow)?.id).toBe('a');
  });

  it('does not report "all spent" when there are no keys at all', () => {
    // No keys is "not configured", which has a different fix than "come back
    // tomorrow" and must not be reported as a quota problem.
    expect(allSpent([], {}, MIDDAY)).toBe(false);
  });

  it('goes back to the first key once its day rolls over, not to the last used', () => {
    const st = withExhausted({}, 'a', MIDDAY);
    expect(pickKey(KEYS, st, MIDDAY + 24 * 3600_000)?.id).toBe('a');
  });
});

describe('keyReport', () => {
  it('marks exactly one key active and the rest standby', () => {
    const r = keyReport(KEYS, withExhausted({}, 'a', MIDDAY), MIDDAY);
    expect(r.map((x) => x.state)).toEqual(['exhausted', 'active', 'standby']);
  });
});

describe('status bookkeeping', () => {
  it('withCleared forgets a key entirely', () => {
    const st = withInvalid(withExhausted({}, 'a', MIDDAY), 'a', 'nope', MIDDAY);
    expect(withCleared(st, 'a')).toEqual({});
  });

  it('pruneStatuses drops deleted keys and yesterday’s exhaustion', () => {
    const st: KeyStatuses = {
      a: { exhaustedOn: '2026-08-14' },
      b: { exhaustedOn: quotaDay(MIDDAY) },
      c: { invalid: 'revoked' },
      gone: { exhaustedOn: quotaDay(MIDDAY) },
    };
    const next = pruneStatuses(st, KEYS, MIDDAY);
    expect(next.a).toBeUndefined();
    expect(next.b?.exhaustedOn).toBe(quotaDay(MIDDAY));
    // An invalid key does not become valid again tomorrow.
    expect(next.c?.invalid).toBe('revoked');
    expect(next.gone).toBeUndefined();
  });
});

describe('moveKey', () => {
  it('reorders', () => {
    expect(moveKey(KEYS, 0, 1).map((k) => k.id)).toEqual(['b', 'a', 'c']);
    expect(moveKey(KEYS, 2, -1).map((k) => k.id)).toEqual(['a', 'c', 'b']);
  });

  it('is a no-op at the ends instead of wrapping around', () => {
    expect(moveKey(KEYS, 0, -1).map((k) => k.id)).toEqual(['a', 'b', 'c']);
    expect(moveKey(KEYS, 2, 1).map((k) => k.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('keyFingerprint', () => {
  it('shows only the tail', () => {
    expect(keyFingerprint('AIzaSyABCDEFG1234')).toBe('••••1234');
    expect(keyFingerprint('abc')).toBe('••••');
  });
});
