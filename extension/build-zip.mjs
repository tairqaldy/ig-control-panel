#!/usr/bin/env node
/**
 * Package the extension: validates, then writes extension/dist/resurfly-companion-<version>[-store].zip
 * containing only the runtime files (no build scripts, no node tooling).
 *
 *   node extension/build-zip.mjs           → dev / self-hoster build (manifest.json verbatim)
 *   node extension/build-zip.mjs --store   → Chrome Web Store build
 *
 * The store build differs from the repo manifest in exactly one way: `optional_host_permissions` is removed.
 * That key contains the `https://` wildcard pattern self-hosters need to point the extension at their own instance,
 * and a reviewer reads a wildcard as "this extension wants every site". The store build talks to resurfly.com
 * only. popup.js and options.js read `optional_host_permissions` back out of the manifest at runtime and hide
 * the App-URL field when it is absent, so the store build has no dead control.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'server', 'package.json'));
const AdmZip = require('adm-zip');

const STORE = process.argv.includes('--store');

execFileSync(process.execPath, [path.join(here, 'validate.mjs')], { stdio: 'inherit' });

const raw = fs.readFileSync(path.join(here, 'manifest.json'), 'utf8');
const manifest = JSON.parse(raw);

/** The manifest that actually goes into the zip. */
let manifestText = raw;
if (STORE) {
  const m = JSON.parse(raw);
  delete m.optional_host_permissions;
  manifestText = JSON.stringify(m, null, 2) + '\n';

  // guard rails: the whole point of this variant
  if ('optional_host_permissions' in m) throw new Error('store manifest still has optional_host_permissions');
  const wildcard = (list) => (list || []).some((h) => /<all_urls>|\*:\/\/\*\/\*|https:\/\/\*\//.test(h));
  if (wildcard(m.host_permissions)) throw new Error('store manifest has a wildcard host permission');
  if (!(m.host_permissions || []).includes('https://resurfly.com/*')) throw new Error('store manifest lost https://resurfly.com/*');
  if (!(m.permissions || []).includes('contextMenus')) throw new Error('store manifest lost contextMenus');
}

const files = ['manifest.json', 'background.js', 'popup.html', 'popup.css', 'popup.js', 'options.html', 'options.js', 'lib/api.js', 'lib/core.js', 'lib/store.js', 'lib/sync.js', 'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png'];
for (const f of files) if (!fs.existsSync(path.join(here, f))) throw new Error('missing ' + f);

const dist = path.join(here, 'dist');
fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, `resurfly-companion-${manifest.version}${STORE ? '-store' : ''}.zip`);
const zip = new AdmZip();
for (const f of files) {
  if (f === 'manifest.json') zip.addFile('manifest.json', Buffer.from(manifestText, 'utf8'));
  else zip.addLocalFile(path.join(here, f), path.dirname(f) === '.' ? '' : path.dirname(f));
}
zip.writeZip(out);
console.log(`wrote ${out} ${(fs.statSync(out).size / 1024).toFixed(1)} KB (${STORE ? 'store build — no optional_host_permissions, App-URL field hidden' : 'dev build — optional_host_permissions kept for self-hosters'})`);
