#!/usr/bin/env node
/*
 * Keeps harvester/harvester.js (self-contained console script) in sync with harvester/core.js (the ESM source of truth).
 *
 *   node harvester/build.mjs           # rewrite the @core-begin … @core-end block inside harvester.js from core.js
 *   node harvester/build.mjs --check   # exit 1 if harvester.js is out of date (use in CI / before committing)
 *
 * It also refreshes extension/lib/core.js when that folder exists (plain copy — the extension imports it as ESM).
 * The block is inlined with the `export ` keywords stripped, so harvester.js stays a classic script (`node --check` passes,
 * pasteable in DevTools, servable from /harvester.js).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const corePath = path.join(here, 'core.js');
const scriptPath = path.join(here, 'harvester.js');
const extCore = path.join(here, '..', 'extension', 'lib', 'core.js');
const check = process.argv.includes('--check');

const BEGIN = '/* @core-begin */';
const END = '/* @core-end */';

function coreBlock() {
  const src = fs.readFileSync(corePath, 'utf8');
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  if (a < 0 || b < 0 || b < a) throw new Error('core.js: missing @core-begin/@core-end markers');
  const body = src.slice(a + BEGIN.length, b);
  if (/^\s*import\s/m.test(body)) throw new Error('core.js must not contain import statements (it is inlined into a script)');
  // strip the ESM `export` keyword; everything else is plain ES2020 that runs in any browser
  const inlined = body.replace(/^export\s+(?=(const|let|var|function|async\s+function|class)\b)/gm, '');
  return `${BEGIN}\n  // ---- generated from harvester/core.js by \`node harvester/build.mjs\` — do not edit here, edit core.js ----${inlined.replace(/\n(?!$)/g, '\n  ')}${END}`;
}

function inline(script, block) {
  const a = script.indexOf(BEGIN), b = script.indexOf(END);
  if (a < 0 || b < 0 || b < a) throw new Error('harvester.js: missing @core-begin/@core-end markers');
  return script.slice(0, a) + block + script.slice(b + END.length);
}

const block = coreBlock();
const current = fs.readFileSync(scriptPath, 'utf8');
const next = inline(current, block);
let stale = next !== current;
let extStale = false;
if (fs.existsSync(path.dirname(extCore))) {
  const want = fs.readFileSync(corePath, 'utf8');
  extStale = !fs.existsSync(extCore) || fs.readFileSync(extCore, 'utf8') !== want;
}

if (check) {
  if (stale) console.error('harvester/harvester.js is out of date — run `node harvester/build.mjs`');
  if (extStale) console.error('extension/lib/core.js differs from harvester/core.js — run `node harvester/build.mjs`');
  process.exit(stale || extStale ? 1 : 0);
}
if (stale) { fs.writeFileSync(scriptPath, next); console.log('harvester/harvester.js: core block updated'); } else console.log('harvester/harvester.js: up to date');
if (fs.existsSync(path.dirname(extCore))) {
  if (extStale) { fs.copyFileSync(corePath, extCore); console.log('extension/lib/core.js: copied from harvester/core.js'); } else console.log('extension/lib/core.js: up to date');
}
