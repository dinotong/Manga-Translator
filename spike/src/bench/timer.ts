/**
 * Stage timing.
 *
 * The one number M0 exists to produce is seconds-per-page, and the one thing
 * that makes it actionable is knowing which stage owns them. Measure every
 * stage from the start — retrofitting timers after something feels slow is how
 * you end up optimising the wrong one.
 */
export class Timer {
  private readonly marks = new Map<string, number>();
  private readonly started = performance.now();

  async stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.marks.set(name, (this.marks.get(name) ?? 0) + (performance.now() - t0));
    }
  }

  get(name: string): number {
    return this.marks.get(name) ?? 0;
  }

  get total(): number {
    return performance.now() - this.started;
  }

  entries(): [string, number][] {
    return [...this.marks.entries()];
  }
}

export const fmtMs = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;

/** Basic stats over repeated runs — a single sample of a JIT-warmed model lies. */
export function summarize(samples: readonly number[]) {
  if (samples.length === 0) return { n: 0, min: 0, median: 0, mean: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    min: sorted[0]!,
    median:
      sorted.length % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    max: sorted.at(-1)!,
  };
}
