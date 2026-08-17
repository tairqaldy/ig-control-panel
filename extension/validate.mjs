#!/usr/bin/env node
/*
 * Sanity checks for the extension (no bundler, so this is our "build"):
 *   - manifest.json parses, is MV3, has the required keys, every referenced file exists
 *   - every .js file passes `node --check` (syntax) and ESM imports resolve
 *   - lib/core.js is byte-identical to harvester/core.js (shared normalization)
 * Run from anywhere: node extension/validate.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
let failed = 0;
const ok = (m) => console.log('  ok   ' + m);
const bad = (m) => { failed++; console.log('  FAIL ' + m); };

// 1. manifest
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
  ok('manifest.json parses');
} catch (e) {
  bad('manifest.json does not parse: ' + e.message);
  process.exit(1);
}
const req = ['manifest_version', 'name', 'version', 'description', 'icons', 'action', 'background', 'permissions', 'host_permissions'];
for (const k of req) (k in manifest ? ok : bad)(`manifest has "${k}"`);
if (manifest.manifest_version !== 3) bad('manifest_version must be 3'); else ok('manifest_version 3');
if (manifest.name !== 'Resurfly Companion') bad('name must be "Resurfly Companion"'); else ok('name');
if (!/^\d+(\.\d+){1,3}$/.test(manifest.version)) bad('version must be dotted integers'); else ok('version ' + manifest.version);
if (manifest.background && manifest.background.type !== 'module') bad('background.type should be "module" (lib/*.js are ES modules)'); else ok('background is a module worker');
const perms = manifest.permissions || [];
for (const p of ['alarms', 'contextMenus', 'storage']) (perms.includes(p) ? ok : bad)(`permission "${p}"`);
// anything beyond these needs a fresh justification in extension/STORE-LISTING.md before it ships
const ALLOWED_PERMS = new Set(['alarms', 'contextMenus', 'storage']);
const extra = perms.filter((p) => !ALLOWED_PERMS.has(p));
(extra.length ? bad : ok)(extra.length ? `unjustified permission(s): ${extra.join(', ')}` : 'no permissions beyond the justified set');
((manifest.optional_permissions || []).includes('cookies') ? ok : bad)('optional permission "cookies"');
const hosts = manifest.host_permissions || [];
(hosts.includes('https://www.instagram.com/*') ? ok : bad)('host permission instagram.com');
(hosts.includes('https://resurfly.com/*') ? ok : bad)('host permission resurfly.com');
(hosts.some((h) => /<all_urls>|^\*:\/\/\*\/\*$/.test(h)) ? bad : ok)('no <all_urls> in host_permissions');
// the repo manifest is the dev/self-hoster build; `build-zip.mjs --store` strips this key for the store zip
((manifest.optional_host_permissions || []).includes('https://*/*') ? ok : bad)('dev manifest keeps optional_host_permissions for self-hosters');

// referenced files
const files = new Set();
const addIcons = (o) => { if (o && typeof o === 'object') for (const v of Object.values(o)) if (typeof v === 'string') files.add(v); };
addIcons(manifest.icons);
if (manifest.action) { addIcons(manifest.action.default_icon); if (manifest.action.default_popup) files.add(manifest.action.default_popup); }
if (manifest.background && manifest.background.service_worker) files.add(manifest.background.service_worker);
if (manifest.options_ui && manifest.options_ui.page) files.add(manifest.options_ui.page);
if (manifest.options_page) files.add(manifest.options_page);
for (const f of files) (existsSync(join(here, f)) ? ok : bad)(`file exists: ${f}`);

// html → referenced scripts/styles exist
for (const html of ['popup.html', 'options.html']) {
  const p = join(here, html);
  if (!existsSync(p)) continue;
  const src = readFileSync(p, 'utf8');
  for (const m of src.matchAll(/(?:src|href)="([^"#][^"]*)"/g)) {
    const ref = m[1];
    if (/^https?:/.test(ref)) continue;
    (existsSync(join(here, ref)) ? ok : bad)(`${html} → ${ref}`);
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>/.test(src)) bad(`${html} has an inline <script> (blocked by MV3 CSP)`);
}

// 2. node --check on every js file
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name === 'icons') continue;
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(m?js)$/.test(name)) out.push(p);
  }
  return out;
};
for (const f of walk(here)) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); ok('node --check ' + relative(here, f)); }
  catch (e) { bad('node --check ' + relative(here, f) + '\n' + String(e.stderr || e.message)); }
}

// 3. import graph resolves (relative imports only)
for (const f of walk(here)) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)) {
    const target = resolve(dirname(f), m[1]);
    (existsSync(target) ? ok : bad)(`${relative(here, f)} imports ${m[1]}`);
  }
}

// 4. core.js in sync with harvester/core.js
const shared = join(root, 'harvester', 'core.js');
if (existsSync(shared)) {
  const a = readFileSync(shared, 'utf8'); const b = readFileSync(join(here, 'lib', 'core.js'), 'utf8');
  (a === b ? ok : bad)('lib/core.js is identical to harvester/core.js (run: cp harvester/core.js extension/lib/core.js)');
} else {
  console.log('  note harvester/core.js not found — skipped sync check');
}

console.log(failed ? `\n${failed} problem(s).` : '\nAll good.');
process.exit(failed ? 1 : 0);
