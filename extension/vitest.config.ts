import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // core/ is deliberately free of DOM, chrome.* and network, so node is
    // enough. Anything needing a browser belongs in a manual check on a real
    // manga page, not in a unit test that only proves the mock works.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
