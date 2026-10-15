import { BYTES_PER_MB } from './cache-budget';

/**
 * The most one page image may be (D-047).
 *
 * `arrayBuffer()` buffers whatever the host sends. A real page tops out well
 * below this — MangaDex's largest, 3496×4960, is a few MB — so anything past it
 * is a host that is not sending a manga page, and reading on would only cost
 * the worker its memory.
 */
export const MAX_IMAGE_BYTES = 50 * BYTES_PER_MB;

export class TooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`image larger than ${Math.round(limit / BYTES_PER_MB)} MB`);
    this.name = 'TooLargeError';
  }
}

/** A declared Content-Length past the cap, so the body need not be read at all. */
export function declaredTooLarge(contentLength: string | null, limit = MAX_IMAGE_BYTES): boolean {
  if (contentLength === null) return false;
  const n = Number(contentLength);
  return Number.isFinite(n) && n > limit;
}

/**
 * Read a body to the end, refusing past `limit` bytes.
 *
 * Counted while streaming, because Content-Length can be absent or wrong. On
 * overflow the stream is cancelled, which also releases the connection.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  limit = MAX_IMAGE_BYTES,
): Promise<ArrayBuffer> {
  if (!body) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new TooLargeError(limit);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}
