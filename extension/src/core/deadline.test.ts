import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deadline } from './deadline';

describe('deadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('aborts when time runs out and says so', () => {
    const d = deadline(1000);
    vi.advanceTimersByTime(999);
    expect(d.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(d.signal.aborted).toBe(true);
    expect(d.expired()).toBe(true);
  });

  it('follows the caller cancelling, and does not call that a timeout', () => {
    const caller = new AbortController();
    const d = deadline(1000, caller.signal);
    caller.abort();
    expect(d.signal.aborted).toBe(true);
    expect(d.expired()).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(d.expired()).toBe(false);
  });

  it('is already aborted for a caller that already cancelled', () => {
    const caller = new AbortController();
    caller.abort();
    const d = deadline(1000, caller.signal);
    expect(d.signal.aborted).toBe(true);
    expect(d.expired()).toBe(false);
  });

  it('never fires once cleared', () => {
    const d = deadline(1000);
    d.clear();
    vi.advanceTimersByTime(5000);
    expect(d.signal.aborted).toBe(false);
    expect(d.expired()).toBe(false);
  });
});
