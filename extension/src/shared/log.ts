/**
 * Prefixed logging.
 *
 * Four contexts log into four different consoles, and when a friend says "it
 * does not work" the first question is always which one broke. The tag answers
 * that without asking them to reproduce anything.
 */
export function makeLog(tag: string) {
  const prefix = `[mt:${tag}]`;
  return {
    debug: (...args: unknown[]) => console.debug(prefix, ...args),
    info: (...args: unknown[]) => console.info(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  };
}

export type Log = ReturnType<typeof makeLog>;
