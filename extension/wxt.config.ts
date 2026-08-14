import { defineConfig } from 'wxt';

/**
 * WXT config.
 *
 * Everything lives under src/ so `core/` can stay a plain, browser-free library
 * that Vitest runs in node — the whole point of putting the hard logic there.
 */
export default defineConfig({
  srcDir: 'src',
  // Auto-imports hide where a symbol came from, which is exactly the wrong
  // trade for code that has to be correct across four isolated contexts.
  imports: false,
  manifest: {
    name: 'Manga Translator',
    description: 'แปลมังงะเป็นไทยบนหน้าเว็บโดยตรง — ตรวจกล่องข้อความในเครื่อง แปลด้วย Gemini',
    version: '0.1.0',
    permissions: ['offscreen', 'storage', 'contextMenus', 'activeTab'],
    // Needed twice over: to fetch cross-origin CDN images past CORS (the only
    // way to read a tainted <img>), and to reach the Gemini endpoint from the
    // service worker.
    host_permissions: ['<all_urls>'],
    content_security_policy: {
      // 'wasm-unsafe-eval' is what lets onnxruntime-web compile its wasm module.
      // Without it the detector fails at init with a CSP violation, not a
      // helpful error.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self';",
    },
  },
  vite: () => ({
    // Ships prebuilt wasm the bundler must not touch.
    optimizeDeps: { exclude: ['onnxruntime-web'] },
    build: { target: 'es2022' },
  }),
});
