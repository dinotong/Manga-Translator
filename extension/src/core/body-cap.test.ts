import { describe, expect, it } from 'vitest';
import { declaredTooLarge, readCapped, TooLargeError } from './body-cap';

function streamOf(chunks: number[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const n = chunks[i++];
      if (n === undefined) controller.close();
      else controller.enqueue(new Uint8Array(n).fill(i));
    },
    cancel() {
      onCancel?.();
    },
  });
}

describe('readCapped', () => {
  it('reads a body under the limit in order', async () => {
    const buf = new Uint8Array(await readCapped(streamOf([3, 2]), 10));
    expect([...buf]).toEqual([1, 1, 1, 2, 2]);
  });

  it('accepts a body exactly at the limit', async () => {
    expect((await readCapped(streamOf([4, 6]), 10)).byteLength).toBe(10);
  });

  it('refuses past the limit and cancels the stream', async () => {
    let cancelled = false;
    await expect(readCapped(streamOf([6, 6, 6], () => (cancelled = true)), 10)).rejects.toBeInstanceOf(
      TooLargeError,
    );
    expect(cancelled).toBe(true);
  });

  it('treats a missing body as empty', async () => {
    expect((await readCapped(null, 10)).byteLength).toBe(0);
  });
});

describe('declaredTooLarge', () => {
  it('trusts only a numeric Content-Length', () => {
    expect(declaredTooLarge('11', 10)).toBe(true);
    expect(declaredTooLarge('10', 10)).toBe(false);
    expect(declaredTooLarge(null, 10)).toBe(false);
    expect(declaredTooLarge('abc', 10)).toBe(false);
  });
});
