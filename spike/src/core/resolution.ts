/**
 * Re-exported from the extension, not copied.
 *
 * The harness exists to check what the extension will actually draw, so it runs
 * the extension's own `core/` rather than a copy of it. A copy would answer
 * questions about a program nobody ships. Tests for these modules live beside
 * them in `extension/src/core/` and are run from here too — see
 * vitest.config.ts.
 */
export * from '../../../extension/src/core/resolution';
