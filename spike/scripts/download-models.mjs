#!/usr/bin/env node
/**
 * Fetch ONNX weights into models/ and stage the ORT wasm runtime into public/ort/.
 *
 * Weights are data, not code, so they stay out of git (models/ is ignored) and
 * are pulled on demand. The extension will do the same thing at runtime rather
 * than shipping hundreds of MB inside the .crx.
 *
 *   node scripts/download-models.mjs          # detection only (~5 MB)
 *   node scripts/download-models.mjs --all    # + manga-ocr (~140 MB)
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Under public/ so the dev server can serve them; Vite will not read from
// arbitrary paths, and the browser has to fetch the weights over HTTP.
const MODELS = join(ROOT, 'public', 'models');

const ORT_DIST = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');

/**
 * PP-OCRv4 mobile detection, Apache-2.0, ~4.7 MB.
 *
 * v4 rather than v5 only because this mirror has it and the interface is
 * identical — swapping in a newer detector later is a one-line change here.
 * We use PaddleOCR purely to locate text, never to read it: its Japanese
 * recognition mangles vertical lines, which is manga-ocr's job anyway.
 */
const MODELS_INDEX = {
  'ppocr-det': {
    url: 'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx',
    file: 'ppocr-v4-det.onnx',
    bytes: 4_745_517,
    license: 'Apache-2.0',
    default: true,
  },
};

/**
 * manga-ocr, served from our own origin rather than the Hub.
 *
 * Fetching it cross-origin at runtime fights the COEP header the harness needs
 * for wasm threads, and the extension will have to bundle-or-cache weights
 * locally anyway — so mirror the layout transformers.js expects and point
 * env.localModelPath at it.
 *
 * ms57rd rather than the onnx-community mirror: the latter ships no
 * tokenizer.json, which leaves generated token ids permanently undecodable.
 */
const MANGA_OCR = {
  repo: 'ms57rd/manga-ocr-base-ONNX',
  dir: 'manga-ocr-base',
  license: 'Apache-2.0',
  files: [
    'config.json',
    'generation_config.json',
    'preprocessor_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/encoder_model_quantized.onnx',
    'onnx/decoder_model_merged_quantized.onnx',
  ],
};

async function downloadMangaOcr() {
  const base = `https://huggingface.co/${MANGA_OCR.repo}/resolve/main/`;
  console.log(`\n  manga-ocr (${MANGA_OCR.license}) — quantized, ~117 MB`);

  for (const rel of MANGA_OCR.files) {
    const dest = join(MODELS, MANGA_OCR.dir, rel);
    await mkdir(dirname(dest), { recursive: true });

    const have = await fileSize(dest);
    if (have > 0) {
      console.log(`    have  ${rel}  (${(have / 1e6).toFixed(1)} MB)`);
      continue;
    }

    process.stdout.write(`    get   ${rel} ... `);
    const res = await fetch(base + rel, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${rel}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    console.log(`${((await fileSize(dest)) / 1e6).toFixed(1)} MB`);
  }

  await fixPreprocessorConfig();
}

/**
 * Rewrite the upstream preprocessor config into the form transformers.js honours.
 *
 * The repo ships the legacy `"size": 224` scalar, which transformers.js reads as
 * "resize the SHORT edge to 224, keep aspect ratio". The ViT encoder wants a
 * square 224x224 — 196 patches plus a CLS token — so a tall bubble crop arrives
 * as the wrong sequence length and inference dies with:
 *
 *   /embeddings/Add: left operand cannot broadcast on dim 1
 *   LeftShape: {1,43,768}, RightShape: {1,197,768}
 *
 * Stating height and width explicitly pins it to a square. Doing the fix here
 * rather than by hand keeps a fresh clone working after one `npm run models`.
 */
async function fixPreprocessorConfig() {
  const path = join(MODELS, MANGA_OCR.dir, 'preprocessor_config.json');
  const cfg = JSON.parse(await readFile(path, 'utf8'));

  if (typeof cfg.size !== 'number') {
    console.log('    ok    preprocessor_config already explicit');
    return;
  }

  const patched = {
    ...cfg,
    image_processor_type: 'ViTImageProcessor',
    size: { height: cfg.size, width: cfg.size },
    do_rescale: true,
    rescale_factor: 1 / 255,
  };
  await writeFile(path, `${JSON.stringify(patched, null, 2)}\n`);
  console.log(`    fix   preprocessor_config size ${cfg.size} -> {${cfg.size}x${cfg.size}}`);
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

async function download(name, spec) {
  const dest = join(MODELS, spec.file);
  const have = await fileSize(dest);

  if (have === spec.bytes) {
    console.log(`  have  ${name}  (${(have / 1e6).toFixed(1)} MB)`);
    return;
  }
  if (have > 0) {
    console.log(`  redo  ${name}  (size ${have} != expected ${spec.bytes})`);
    await unlink(dest);
  }

  process.stdout.write(`  get   ${name}  ${(spec.bytes / 1e6).toFixed(1)} MB ... `);
  const res = await fetch(spec.url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${spec.url}`);

  // Stream to disk: a 140 MB Buffer in memory is avoidable waste.
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));

  const got = await fileSize(dest);
  if (spec.bytes && got !== spec.bytes) {
    // Truncated downloads are the classic cause of "invalid protobuf" at load.
    await unlink(dest);
    throw new Error(`size mismatch: got ${got}, expected ${spec.bytes}`);
  }
  console.log(`ok (${spec.license})`);
}

/**
 * Confirm the ORT runtime assets exist in node_modules.
 *
 * They are NOT copied into public/: ORT reaches its wasm loader through a
 * dynamic import(), and Vite refuses to serve anything from public/ that way.
 * PpOcrDetector imports them with `?url` instead and lets Vite hand back the
 * resolved paths, which works in dev and in a build.
 */
async function checkOrtRuntime() {
  const entries = await readdir(ORT_DIST).catch(() => []);
  const wanted = entries.filter((f) => /^ort-wasm.*jsep\.(wasm|mjs)$/.test(f));

  if (wanted.length < 2) {
    console.log('  WARN  ort jsep runtime missing — run `npm install`');
    return;
  }
  console.log(`  have  ort runtime in node_modules (${wanted.join(', ')})`);
}

const all = process.argv.includes('--all');

await mkdir(MODELS, { recursive: true });
console.log(`→ ${MODELS}\n`);

await checkOrtRuntime();

for (const [name, spec] of Object.entries(MODELS_INDEX)) {
  if (!spec.default && !all) {
    console.log(`  skip  ${name}  (pass --all)`);
    continue;
  }
  await download(name, spec);
}

if (all) await downloadMangaOcr();
else console.log('\n  skip  manga-ocr  (pass --all, ~117 MB)');

console.log('\ndone. models/ and public/ort/ are gitignored.');
