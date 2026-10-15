/**
 * A request that gives up on its own.
 *
 * Nothing used to bound a Gemini request. Measured while taking store
 * screenshots: a request sent at 17:19:53 got its 503 back almost five
 * minutes later, and for all of that time the page said "translating" with no
 * hint whether to wait or try again. The usual reply time is 3 to 50 seconds
 * (03-work-queue.md), so a request still open well past that is not going to
 * become useful — the reader is better off told to retry.
 *
 * The caller's own signal still wins: a request the caller cancelled reports
 * as cancelled, not as timed out, because the two lead to different messages.
 * Whichever happened first decides — a caller cancelling first clears the
 * timer, so it can never fire; a caller cancelling after the timer fired does
 * not turn a timeout into a cancellation.
 */
export interface Deadline {
  /** Aborts when either the caller cancels or time runs out. */
  signal: AbortSignal;
  /** True when the deadline fired before the caller cancelled. */
  expired(): boolean;
  /** Stop the timer once the request has finished. */
  clear(): void;
}

/**
 * For reading one page image, download *and* body. A CDN that stalls mid-body
 * would otherwise hold the job, and with it a queue slot, forever. Pages are a
 * few MB; a minute is far past any healthy transfer.
 */
export const IMAGE_FETCH_TIMEOUT_MS = 60_000;

export function deadline(ms: number, caller?: AbortSignal): Deadline {
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort(new DOMException(`no reply in ${ms} ms`, 'TimeoutError'));
  }, ms);

  const onCaller = () => {
    clearTimeout(timer);
    controller.abort(caller?.reason);
  };
  if (caller?.aborted) onCaller();
  else caller?.addEventListener('abort', onCaller, { once: true });

  return {
    signal: controller.signal,
    expired: () => fired,
    clear: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCaller);
    },
  };
}
