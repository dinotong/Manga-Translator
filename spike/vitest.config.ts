import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // core/ is deliberately free of DOM and network, so the fast node
    // environment is enough. Anything that needs a browser belongs in the
    // harness page, not in a unit test.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
