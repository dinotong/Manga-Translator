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
 */
export interface Deadline {
  /** Aborts when either the caller cancels or time runs out. */
  signal: AbortSignal;
  /** True only when the deadline fired and the caller had not cancelled first. */
  expired(): boolean;
  /** Stop the timer once the request has finished. */
  clear(): void;
}

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
    expired: () => fired && !caller?.aborted,
    clear: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCaller);
    },
  };
}
