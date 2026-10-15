#!/usr/bin/env node
/**
 * Fetch a handful of manga pages into spike/samples/ as OCR benchmark fixtures.
 *
 * Fixtures are personal test data: they stay local and are gitignored.
 * Keep counts small (~10 pages) and leave the delay alone — this hits someone
 * else's server, and the whole point is a benchmark set, not a mirror.
 *
 *   node spike/fetch-samples.mjs --url "https://host/path/{n}.webp" --from 1 --to 10
 *   node spike/fetch-samples.mjs --url "..." --from 1 --to 10 --label ja-doujin
 *
 * {n}  -> page number
 * {n2} -> page number zero-padded to 2 (some sites use 01.jpg)
 * {n3} -> zero-padded to 3
 */

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'samples');
const DELAY_MS = 800; // be polite; do not lower this
const TIMEOUT_MS = 20_000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, '');
    if (k) out[k] = argv[i + 1];
  }
  return out;
}

function expand(tpl, n) {
  return tpl
    .replaceAll('{n3}', String(n).padStart(3, '0'))
    .replaceAll('{n2}', String(n).padStart(2, '0'))
    .replaceAll('{n}', String(n));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function fetchPage(url, referer) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // Many manga CDNs 403 without a referer from the reader page.
        referer,
        'user-agent': 'Mozilla/5.0 manga-translator-spike/0.1',
        accept: 'image/webp,image/avif,image/*,*/*;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args.url) {
  console.error('usage: node spike/fetch-samples.mjs --url "https://host/{n}.webp" --from 1 --to 10 [--label name] [--referer URL]');
  process.exit(1);
}

const from = Number(args.from ?? 1);
const to = Number(args.to ?? 10);
const label = args.label ?? 'set';
const referer = args.referer ?? new URL(args.url.replace(/\{n\d?\}/g, '1')).origin + '/';

if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
  console.error('--from/--to must be numbers with to >= from');
  process.exit(1);
}
if (to - from + 1 > 40) {
  console.error(`refusing ${to - from + 1} pages — these are benchmark fixtures, grab ~10`);
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });
console.log(`→ ${OUT_DIR}  (pages ${from}..${to}, ${DELAY_MS}ms apart)\n`);

let ok = 0;
let skipped = 0;
const failed = [];

for (let n = from; n <= to; n++) {
  const url = expand(args.url, n);
  const ext = (url.split('.').pop() ?? 'jpg').split(/[?#]/)[0];
  const dest = join(OUT_DIR, `${label}-${String(n).padStart(3, '0')}.${ext}`);

  if (await exists(dest)) {
    console.log(`  skip  ${label}-${n} (already have it)`);
    skipped++;
    continue;
  }

  try {
    const buf = await fetchPage(url, referer);
    await writeFile(dest, buf);
    console.log(`  ok    ${label}-${n}  ${(buf.length / 1024).toFixed(0)} KB`);
    ok++;
  } catch (err) {
    console.log(`  FAIL  ${label}-${n}  ${err.message}`);
    failed.push(n);
  }

  if (n < to) await sleep(DELAY_MS);
}

console.log(`\ndone: ${ok} fetched, ${skipped} skipped, ${failed.length} failed${failed.length ? ` (${failed.join(', ')})` : ''}`);
if (ok + skipped > 0) {
  console.log('\nnext: write ground truth for ~50 bubbles into spike/groundtruth.json');
  console.log('      the benchmark is meaningless without something to score against');
}
