#!/usr/bin/env node
/**
 * Rebrand helper: swaps the PRODUCT name in user-facing text (docs, UI strings, harvester panel, prompts)
 * while leaving internal identifiers alone (DB filename, schema fields, cookie name, API routes, meta keys).
 *
 *   node scripts/rebrand.mjs "Undig" "NewName"
 *
 * The daily-picks feature inside the app keeps its own name ("Resurface"); it is not touched.
 * This script skips itself (scripts/), node_modules, dist, data, private.
 */
import fs from 'node:fs';
import path from 'node:path';

const [oldName, newName] = process.argv.slice(2);
if (!oldName || !newName) { console.error('usage: node scripts/rebrand.mjs <OldName> <NewName>'); process.exit(1); }
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'data', '.git', 'private', 'scripts']);
const EXT = new Set(['.md', '.ts', '.tsx', '.js', '.mjs', '.html', '.json', '.svg', '.example', '.txt']);
const FEATURE = 'Resurface'; // daily-picks feature name, protected
const PROTECT = [
  // internal identifiers (never rename: DB on disk, schema fields, cookie, meta keys, routes, DOM ids)
  /resurface\.db/gi, /resurface_prompt/g, /resurface-harvest/g, /__resurface/g, /resurface-harvester/g, /rs_session/g, /\/resurface/g, /resurface_picks/g, /resurface_notes/g, /resurface_seen/g,
  /pickResurface|resurfaceNotes|markResurfaced|last_resurfaced_at|resurface_count|computePicks/g, /queryKey: \['resurface'\]/g, /pages\/Resurface/g, /function Resurface\(/g, /<Resurface \/>/g, /import Resurface/g,
  // the daily-picks FEATURE keeps its name
  new RegExp(`${FEATURE} · `, 'g'), new RegExp(`label: '${FEATURE}'`, 'g'), new RegExp(`l: '${FEATURE}'`, 'g'), new RegExp(`\\*\\*${FEATURE}\\*\\* — three`, 'g'), new RegExp(`daily ${FEATURE}`, 'g'), new RegExp(`${FEATURE} daily`, 'g'), new RegExp(`${FEATURE} page`, 'g'), new RegExp(`${FEATURE} \\(daily`, 'g'), new RegExp(`${FEATURE} Today`, 'g'), new RegExp(`${FEATURE}/Serendipity`, 'g'),
];
const PH = (i) => `@@TOKEN_${i}@@`;
let files = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!EXT.has(path.extname(e.name)) && !e.name.startsWith('.env')) continue;
    let s = fs.readFileSync(p, 'utf8');
    const before = s;
    const tokens = [];
    for (const re of PROTECT) s = s.replace(re, (m) => { tokens.push(m); return PH(tokens.length - 1); });
    s = s.replace(new RegExp(oldName, 'g'), newName).replace(new RegExp(oldName.toLowerCase(), 'g'), newName.toLowerCase()).replace(new RegExp(oldName.toUpperCase(), 'g'), newName.toUpperCase());
    s = s.replace(/@@TOKEN_(\d+)@@/g, (_, i) => tokens[Number(i)]);
    if (s !== before) { fs.writeFileSync(p, s); files++; console.log('rebranded', path.relative(root, p)); }
  }
}
walk(root);
console.log(`done: ${files} files. Review with git diff. Then: rename the GitHub repo, update PUBLIC_URL/domain, and (optionally) the Railway project name.`);
