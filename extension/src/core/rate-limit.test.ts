import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMIT,
  FREE_TIER_RPM,
  nextSlotAt,
  noteSent,
  PACED_RPM,
  pickPaced,
  RATE_WINDOW_MS,
  recent,
  waitFor,
} from './rate-limit';

const T = 1_700_000_000_000;

describe('recent', () => {
  it('drops what has aged out of the window and sorts the rest', () => {
    expect(recent([T - 90_000, T - 30_000, T - 10_000], T, RATE_WINDOW_MS)).toEqual([
      T - 30_000,
      T - 10_000,
    ]);
  });

  it('treats the boundary as expired', () => {
    expect(recent([T - RATE_WINDOW_MS], T, RATE_WINDOW_MS)).toEqual([]);
  });
});

describe('nextSlotAt', () => {
  it('is now when the window is empty', () => {
    expect(nextSlotAt([], T)).toBe(T);
  });

  it('is now while there is still room', () => {
    const sent = Array.from({ length: PACED_RPM - 1 }, (_, i) => T - i * 1000);
    expect(nextSlotAt(sent, T)).toBe(T);
  });

  it('waits for the oldest request to fall out once the window is full', () => {
    const oldest = T - 50_000;
    const sent = [oldest, ...Array.from({ length: PACED_RPM - 1 }, (_, i) => T - i * 100)];
    expect(nextSlotAt(sent, T)).toBe(oldest + RATE_WINDOW_MS);
  });

  it('paces one below the real ceiling so the last slot is not a coin flip', () => {
    expect(PACED_RPM).toBe(FREE_TIER_RPM - 1);
    const sent = Array.from({ length: PACED_RPM }, (_, i) => T - i * 100);
    expect(nextSlotAt(sent, T)).toBeGreaterThan(T);
  });

  it('needs several to expire when the window is over-full', () => {
    // Over-full happens for real: the Options page's "test this key" button
    // spends the same allowance, and a worker restart re-reads the record.
    const extra = 2;
    // Oldest first, one second apart, so the nth-oldest is identifiable.
    const sent = Array.from({ length: PACED_RPM + extra }, (_, i) => T - (PACED_RPM + extra - i) * 1000);
    // With `extra` over the limit, room appears only once `extra + 1` have gone.
    expect(nextSlotAt(sent, T)).toBe(sent[extra]! + RATE_WINDOW_MS);
  });

  it('never permits anything when the limit is zero', () => {
    expect(nextSlotAt([], T, { limit: 0, windowMs: RATE_WINDOW_MS })).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('waitFor', () => {
  it('is zero when a slot is free', () => {
    expect(waitFor([], T)).toBe(0);
  });

  it('is the remaining life of the oldest request otherwise', () => {
    const sent = Array.from({ length: PACED_RPM }, () => T - 20_000);
    expect(waitFor(sent, T)).toBe(RATE_WINDOW_MS - 20_000);
  });
});

describe('noteSent', () => {
  it('appends now and prunes in one step', () => {
    expect(noteSent([T - 90_000, T - 1_000], T)).toEqual([T - 1_000, T]);
  });

  it('keeps a busy window bounded to the window itself', () => {
    let sent: number[] = [];
    for (let i = 0; i < 500; i++) sent = noteSent(sent, T + i * 1000);
    expect(sent.length).toBeLessThanOrEqual(61);
  });
});

describe('pickPaced', () => {
  const loads = new Map<string, number[]>();
  const sentOf = (k: string) => loads.get(k) ?? [];

  it('prefers the first key while it has room, so a spare stays a spare', () => {
    loads.clear();
    loads.set('a', [T - 1000]);
    loads.set('b', []);
    expect(pickPaced(['a', 'b'], sentOf, T)?.key).toBe('a');
  });

  it('moves to the second key when the first is out of per-minute room', () => {
    loads.clear();
    loads.set('a', Array.from({ length: PACED_RPM }, () => T - 5_000));
    loads.set('b', []);
    const picked = pickPaced(['a', 'b'], sentOf, T);
    expect(picked?.key).toBe('b');
    expect(picked?.readyAt).toBe(T);
  });

  it('returns the soonest key when every key is saturated, rather than nothing', () => {
    loads.clear();
    loads.set('a', Array.from({ length: PACED_RPM }, () => T - 5_000));
    loads.set('b', Array.from({ length: PACED_RPM }, () => T - 40_000));
    const picked = pickPaced(['a', 'b'], sentOf, T);
    expect(picked?.key).toBe('b');
    expect(picked?.readyAt).toBe(T - 40_000 + RATE_WINDOW_MS);
  });

  it('gives two keys twice the throughput of one', () => {
    loads.clear();
    loads.set('a', []);
    loads.set('b', []);
    let sent = 0;
    for (let i = 0; i < 40; i++) {
      const at = T + i * 100; // a burst well inside one window
      const pick = pickPaced(['a', 'b'], sentOf, at);
      if (!pick || pick.readyAt > at) break;
      loads.set(pick.key, noteSent(sentOf(pick.key), at));
      sent++;
    }
    expect(sent).toBe(PACED_RPM * 2);
  });

  it('is null when there are no keys at all', () => {
    expect(pickPaced([], sentOf, T)).toBeNull();
  });

  it('uses the default limit unless told otherwise', () => {
    expect(DEFAULT_LIMIT.limit).toBe(PACED_RPM);
    expect(DEFAULT_LIMIT.windowMs).toBe(RATE_WINDOW_MS);
  });
});
