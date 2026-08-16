import { describe, expect, it } from 'vitest';
import {
  canAdmit,
  clampInFlight,
  compareWork,
  DEFAULT_MAX_IN_FLIGHT,
  MAX_IN_FLIGHT_CEILING,
  nextToRun,
  NOTHING_RUNNING,
  type Running,
  total,
  type WorkKind,
} from './scheduling';

const running = (patch: Partial<Running> = {}): Running => ({ ...NOTHING_RUNNING, ...patch });
const job = (kind: WorkKind, distance: number, id = `${kind}-${distance}`) => ({ kind, distance, id });

describe('clampInFlight', () => {
  it('keeps sensible values', () => {
    expect(clampInFlight(1)).toBe(1);
    expect(clampInFlight(4)).toBe(4);
    expect(clampInFlight(MAX_IN_FLIGHT_CEILING)).toBe(MAX_IN_FLIGHT_CEILING);
  });

  it('refuses zero — that would stop the extension dead', () => {
    expect(clampInFlight(0)).toBe(1);
    expect(clampInFlight(-3)).toBe(1);
  });

  it('caps a hand-edited storage value', () => {
    expect(clampInFlight(500)).toBe(MAX_IN_FLIGHT_CEILING);
  });

  it('falls back to the default on nonsense rather than to the ceiling', () => {
    expect(clampInFlight('abc')).toBe(DEFAULT_MAX_IN_FLIGHT);
    expect(clampInFlight(undefined)).toBe(DEFAULT_MAX_IN_FLIGHT);
    expect(clampInFlight(Number.NaN)).toBe(DEFAULT_MAX_IN_FLIGHT);
  });
});

describe('canAdmit', () => {
  it('lets work start while there is room', () => {
    expect(canAdmit('foreground', NOTHING_RUNNING, 4)).toBe(true);
    expect(canAdmit('manual', NOTHING_RUNNING, 4)).toBe(true);
    expect(canAdmit('speculative', NOTHING_RUNNING, 4)).toBe(true);
  });

  it('stops everything at the cap', () => {
    const full = running({ foreground: 4 });
    expect(total(full)).toBe(4);
    for (const kind of ['manual', 'foreground', 'speculative'] as WorkKind[]) {
      expect(canAdmit(kind, full, 4)).toBe(false);
    }
  });

  it('never lets speculation take the last slot', () => {
    const nearlyFull = running({ speculative: 3 });
    expect(canAdmit('speculative', nearlyFull, 4)).toBe(false);
    expect(canAdmit('foreground', nearlyFull, 4)).toBe(true);
    expect(canAdmit('manual', nearlyFull, 4)).toBe(true);
  });

  it('reserves the slot even when the running work is a mix', () => {
    expect(canAdmit('speculative', running({ foreground: 1, speculative: 2 }), 4)).toBe(false);
    expect(canAdmit('manual', running({ foreground: 1, speculative: 2 }), 4)).toBe(true);
  });

  it('means no speculation at all when only one job may run', () => {
    // A reader who pins concurrency to 1 has asked for their page and nothing
    // else; a guess would be the thing occupying it.
    expect(canAdmit('speculative', NOTHING_RUNNING, 1)).toBe(false);
    expect(canAdmit('foreground', NOTHING_RUNNING, 1)).toBe(true);
  });

  it('treats a nonsensical cap as one rather than as none', () => {
    expect(canAdmit('foreground', NOTHING_RUNNING, 0)).toBe(true);
    expect(canAdmit('foreground', running({ foreground: 1 }), 0)).toBe(false);
  });
});

describe('compareWork', () => {
  it('puts a right-click ahead of everything, wherever it is on screen', () => {
    expect(compareWork(job('manual', 9999), job('foreground', 0))).toBeLessThan(0);
    expect(compareWork(job('manual', 9999), job('speculative', 0))).toBeLessThan(0);
  });

  it('puts a visible page ahead of a guess', () => {
    expect(compareWork(job('foreground', 500), job('speculative', 0))).toBeLessThan(0);
  });

  it('falls back to distance from the viewport centre within one kind', () => {
    expect(compareWork(job('foreground', 10), job('foreground', 900))).toBeLessThan(0);
    expect(compareWork(job('speculative', 900), job('speculative', 10))).toBeGreaterThan(0);
  });

  it('sorts a mixed queue the way the reader would expect', () => {
    const queue = [
      job('speculative', 10, 'guess-near'),
      job('foreground', 800, 'far-page'),
      job('manual', 4000, 'right-clicked'),
      job('foreground', 20, 'near-page'),
    ];
    expect([...queue].sort(compareWork).map((j) => j.id)).toEqual([
      'right-clicked',
      'near-page',
      'far-page',
      'guess-near',
    ]);
  });
});

describe('nextToRun', () => {
  it('is null on an empty queue', () => {
    expect(nextToRun([], NOTHING_RUNNING, 4)).toBeNull();
  });

  it('takes the right-clicked page first even when guesses queued earlier', () => {
    const queue = [job('speculative', 0, 'guess'), job('manual', 5000, 'clicked')];
    expect(nextToRun(queue, NOTHING_RUNNING, 4)?.id).toBe('clicked');
  });

  it('steps over a guess it may not admit rather than stalling on it', () => {
    // The reserve is full of speculation; the reader's own page must still go.
    const queue = [job('speculative', 0, 'guess'), job('foreground', 900, 'page')];
    expect(nextToRun(queue, running({ speculative: 3 }), 4)?.id).toBe('page');
  });

  it('is null when the cap is reached, whatever is queued', () => {
    const queue = [job('manual', 0, 'clicked')];
    expect(nextToRun(queue, running({ foreground: 4 }), 4)).toBeNull();
  });

  it('never returns a guess before a request the reader made', () => {
    // Exhaustive over the orderings that could arise from arrival time.
    const clicked = job('manual', 3000, 'clicked');
    const guesses = [job('speculative', 0, 'g1'), job('speculative', 1, 'g2')];
    for (const queue of [[...guesses, clicked], [clicked, ...guesses], [guesses[0]!, clicked, guesses[1]!]]) {
      expect(nextToRun(queue, NOTHING_RUNNING, 4)?.id).toBe('clicked');
    }
  });
});
