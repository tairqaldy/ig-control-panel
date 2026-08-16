#!/usr/bin/env node
/**
 * Package the extension for the Chrome Web Store: validates, then writes extension/dist/resurfly-companion-<version>.zip
 * containing only the runtime files (no build scripts, no node tooling).
 *
 *   node extension/build-zip.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'server', 'package.json'));
const AdmZip = require('adm-zip');

execFileSync(process.execPath, [path.join(here, 'validate.mjs')], { stdio: 'inherit' });

const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'));
const files = ['manifest.json', 'background.js', 'popup.html', 'popup.css', 'popup.js', 'options.html', 'options.js', 'lib/api.js', 'lib/core.js', 'lib/store.js', 'lib/sync.js', 'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png'];
for (const f of files) if (!fs.existsSync(path.join(here, f))) throw new Error('missing ' + f);
const dist = path.join(here, 'dist');
fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, `resurfly-companion-${manifest.version}.zip`);
const zip = new AdmZip();
for (const f of files) zip.addLocalFile(path.join(here, f), path.dirname(f) === '.' ? '' : path.dirname(f));
zip.writeZip(out);
console.log('wrote', out, (fs.statSync(out).size / 1024).toFixed(1) + ' KB');
