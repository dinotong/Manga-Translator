import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const SAMPLES = join(import.meta.dirname, 'samples');

const MIME: Record<string, string> = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.avif': 'image/avif',
};

/**
 * Serve samples/ over HTTP in dev.
 *
 * The fixtures are copyrighted pages that must stay out of git, so they live
 * outside public/. Exposing them through a dev-only middleware keeps that true
 * while letting the harness run the whole set in one click — drag-and-drop is
 * fine for one page and tedious for the tenth.
 */
function samplesPlugin(): Plugin {
  return {
    name: 'spike-samples',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';

        /*
         * Dev-only convenience: hand the harness the key from spike/.env so it
         * does not have to be pasted on every fresh profile.
         *
         * Served from a middleware rather than injected via `define` on purpose
         * — this plugin is `apply: 'serve'`, so the key can never end up baked
         * into a build artifact. .env is gitignored.
         */
        if (url === '/dev/config') {
          const key = process.env.GEMIIN_API_KEY ?? process.env.GEMINI_API_KEY ?? '';
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ geminiApiKey: key }));
          return;
        }

        if (!url.startsWith('/samples/')) return next();

        try {
          if (url === '/samples/index.json') {
            const files = (await readdir(SAMPLES))
              .filter((f) => extname(f).toLowerCase() in MIME)
              .sort();
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(files));
            return;
          }

          // Strip any query string, and refuse anything that tries to escape.
          const name = decodeURIComponent(url.slice('/samples/'.length).split('?')[0] ?? '');
          if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
            res.statusCode = 400;
            res.end('bad name');
            return;
          }

          const body = await readFile(join(SAMPLES, name));
          res.setHeader('content-type', MIME[extname(name).toLowerCase()] ?? 'application/octet-stream');
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.end('not found');
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Vite only auto-exposes VITE_-prefixed vars; load the rest into process.env
  // so the dev middleware above can read GEMIIN_API_KEY from spike/.env.
  Object.assign(process.env, loadEnv(mode, import.meta.dirname, ''));

  return {
  plugins: [samplesPlugin()],
  server: {
    // onnxruntime-web multi-threading needs SharedArrayBuffer, which needs
    // cross-origin isolation. Whether the threaded path is worth it is one of
    // the things M0 measures, so keep it available.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      // credentialless, not require-corp: the strict form demands a CORP header
      // on every cross-origin subresource, which the HF CDN does not send, so
      // model downloads die with ERR_HTTP2_PROTOCOL_ERROR. This still grants
      // crossOriginIsolated (and therefore SharedArrayBuffer / wasm threads).
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  optimizeDeps: {
    // Ships prebuilt wasm/worker assets that Vite should not try to bundle.
    exclude: ['onnxruntime-web', '@huggingface/transformers'],
  },
    build: { target: 'es2022' },
  };
});
