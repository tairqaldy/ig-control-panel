#!/usr/bin/env node
/*
 * Render web/public/favicon.svg to the PNG sizes Chrome wants (16/32/48/128) into extension/icons/.
 * Uses `sharp` from the repo's node_modules (a server dependency). Run from the repo root:
 *   node extension/build-icons.mjs
 * The PNGs are committed, so this only needs to run again when the favicon changes.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(join(root, 'server', 'package.json'));
const sharp = require('sharp');

const src = join(root, 'web', 'public', 'favicon.svg');
const outDir = join(here, 'icons');
mkdirSync(outDir, { recursive: true });
const svg = readFileSync(src);

for (const size of [16, 32, 48, 128]) {
  const png = await sharp(svg, { density: Math.max(72, Math.round((size / 64) * 72 * 4)) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const out = join(outDir, `icon${size}.png`);
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}
