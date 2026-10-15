// Writes .output/SHA256SUMS (sha256sum format) covering every release zip in
// .output for the current package.json version (older zips are left out), so users can check a download with `sha256sum -c SHA256SUMS`
// or `Get-FileHash`. Run automatically by `npm run zip`.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const outDir = join(root, '.output');
const zips = readdirSync(outDir)
  .filter((f) => f.endsWith('.zip') && f.includes(`-${version}-`))
  .sort();

if (zips.length === 0) {
  console.error(`no .zip for version ${version} in ${outDir} - run wxt zip first`);
  process.exit(1);
}

const lines = zips.map((f) => {
  const hex = createHash('sha256').update(readFileSync(join(outDir, f))).digest('hex');
  return `${hex}  ${f}`;
});
writeFileSync(join(outDir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
