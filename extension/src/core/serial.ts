/**
 * Run tasks one at a time, in the order they were queued.
 *
 * For read-modify-writes that must not interleave within one context, and for
 * resources that are not re-entrant. A task that fails rejects its own caller
 * and nothing else: the tasks queued behind it still run.
 */
export function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };
}
