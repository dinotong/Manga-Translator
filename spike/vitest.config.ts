import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // core/ is deliberately free of DOM and network, so the fast node
    // environment is enough. Anything that needs a browser belongs in the
    // harness page, not in a unit test.
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      // The harness runs the extension's own core/ (see src/core/*.ts), so it
      // runs the extension's tests for it as well. Duplicating them here is how
      // the two copies used to drift; pointing at the single home is how they
      // cannot.
      '../extension/src/core/**/*.test.ts',
    ],
  },
});
