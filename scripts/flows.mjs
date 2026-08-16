#!/usr/bin/env node
/**
 * Interaction-level smoke on a live deployment: click through the main flows as owner and as a fresh trial user.
 * Collects console/page errors + failed requests per step and screenshots the end state of each step.
 *
 *   CAPTURE_USER=… CAPTURE_PASS=… node scripts/flows.mjs https://resurfly.com <outDir>
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const [base, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function withPage(browser, label, loginFn, steps) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const issues = [];
  page.on('pageerror', (e) => issues.push('pageerror: ' + String(e.message).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') issues.push('console: ' + m.text().slice(0, 200)); });
  page.on('response', (r) => { const s = r.status(); if (s >= 500) issues.push(`http ${s} ${r.request().method()} ${r.url().slice(0, 120)}`); });
  page.on('dialog', async (d) => { await d.accept(); });
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(base + '/login', { waitUntil: 'domcontentloaded' });
  await loginFn(page);
  for (const [name, fn] of steps) {
    const before = issues.length; const t0 = Date.now();
    try { await fn(page); results.push({ label, name, ok: true, ms: Date.now() - t0, issues: issues.slice(before) }); }
    catch (e) { results.push({ label, name, ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 220), issues: issues.slice(before) }); }
    try { await page.screenshot({ path: path.join(outDir, `${label}-${name}.png`) }); } catch {}
  }
  await ctx.close();
}
const go = async (page, url, ms = 1200) => { await page.goto(base + url, { waitUntil: 'domcontentloaded' }); try { await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }); } catch {} await sleep(ms); };
const clickText = async (page, selector, text, opts = {}) => {
  const handle = await page.evaluateHandle((sel, t) => [...document.querySelectorAll(sel)].find((el) => (el.innerText || '').trim().toLowerCase().includes(t.toLowerCase()) && el.offsetParent !== null), selector, text);
  const el = handle.asElement(); if (!el) throw new Error(`no ${selector} with text "${text}"`);
  await el.click(); await sleep(opts.wait ?? 800); return el;
};
const expectText = async (page, re) => { const t = await page.evaluate(() => document.body.innerText); if (!re.test(t)) throw new Error(`expected /${re.source}/`); };

const ownerLogin = async (page) => { const st = await page.evaluate(async (u, p) => (await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, passcode: p }) })).status, process.env.CAPTURE_USER, process.env.CAPTURE_PASS); if (st !== 200) throw new Error('owner login ' + st); };
let trialEmail = `flows-${Date.now()}@example.com`;
const trialSignup = async (page) => { const st = await page.evaluate(async (e) => (await fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: 'flows-passw0rd' }) })).status, trialEmail); if (st !== 200) throw new Error('signup ' + st); };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 90000, args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--lang=en-US'] });
try {
  await withPage(browser, 'owner', ownerLogin, [
    ['library-filter', async (p) => { await go(p, '/library'); await clickText(p, 'button', 'Filters'); await sleep(500); await expectText(p, /Category|Creator/i); }],
    ['library-search', async (p) => { await go(p, '/library'); await p.type('input[type="search"], input[placeholder*="Search"]', 'storytelling'); await p.keyboard.press('Enter'); await sleep(2500); await expectText(p, /storytell/i); }],
    ['item-modal', async (p) => { await go(p, '/library'); const card = await p.$('main article, main [role="button"][aria-label], main button[aria-label*="Open"]'); if (!card) throw new Error('no card'); await card.click(); await sleep(2000); await expectText(p, /Summary|Key points|Transcript/i); }],
    ['item-modal-brief', async (p) => { await clickText(p, 'button, a', 'Turn into a brief', { wait: 2500 }); await expectText(p, /brief/i); }],
    ['ask-send', async (p) => { await go(p, '/ask'); const ta = await p.$('main textarea'); await ta.click(); await p.keyboard.type('Give me two saves about hooks, one line each.'); await p.keyboard.press('Enter'); await sleep(9000); await expectText(p, /#|sources|Reading/i); }],
    ['ask-rail-new', async (p) => { await clickText(p, 'button', 'New', { wait: 600 }); await expectText(p, /Ask it like|What can Ask do|suggest/i); }],
    ['analytics-range', async (p) => { await go(p, '/analytics'); await clickText(p, 'button', '90d', { wait: 2500 }); await expectText(p, /90|Followers/i); }],
    ['automations-toggle', async (p) => { await go(p, '/automations'); const sw = await p.$('main [role="switch"]'); if (!sw) throw new Error('no switch'); await sw.click(); await sleep(1500); await sw.click(); await sleep(1000); }],
    ['automations-dryrun', async (p) => { await clickText(p, 'button', 'Dry run', { wait: 2000 }); }],
    ['import-pairing', async (p) => { await go(p, '/import'); await clickText(p, 'button', 'Get pairing code', { wait: 2000 }); await expectText(p, /RSF-/); }],
    ['settings-save', async (p) => { await go(p, '/settings'); await clickText(p, 'button', 'Save changes', { wait: 1500 }); }],
    ['graph-view', async (p) => { await go(p, '/graph', 3000); await clickText(p, 'button', 'View', { wait: 800 }); await expectText(p, /Everything|Map/); }],
    ['resurface-random', async (p) => { await go(p, '/resurface'); await clickText(p, 'button', 'Random save', { wait: 2000 }); }],
    ['palette', async (p) => { await go(p, '/'); await p.keyboard.down('Control'); await p.keyboard.press('k'); await p.keyboard.up('Control'); await sleep(600); await p.keyboard.type('analytics'); await sleep(600); await p.keyboard.press('Enter'); await sleep(1500); if (!/\/analytics/.test(p.url())) throw new Error('palette nav failed: ' + p.url()); }],
    ['billing', async (p) => { await go(p, '/billing'); await expectText(p, /Studio/); }],
  ]);
  await withPage(browser, 'trial', trialSignup, [
    ['welcome-1', async (p) => { await go(p, '/'); if (!/\/welcome/.test(p.url())) throw new Error('no redirect to welcome: ' + p.url()); await expectText(p, /Bring your saves/i); }],
    ['welcome-pair', async (p) => { await clickText(p, 'button', 'Get pairing code', { wait: 2000 }); await expectText(p, /RSF-/); }],
    ['welcome-2', async (p) => { await go(p, '/welcome?step=2'); await expectText(p, /analy|Waiting|Start/i); }],
    ['welcome-3', async (p) => { await go(p, '/welcome?step=3'); await expectText(p, /Ask/i); }],
    ['ask-quota-pill', async (p) => { await go(p, '/ask'); await expectText(p, /20 questions|\/ 20/i); }],
    ['ask-empty-library', async (p) => { const ta = await p.$('main textarea'); await ta.click(); await p.keyboard.type('hello?'); await p.keyboard.press('Enter'); await sleep(6000); }],
    ['analytics-demo', async (p) => { await go(p, '/analytics'); await expectText(p, /Sample|sample|demo/i); }],
    ['automations-connect-card', async (p) => { await go(p, '/automations'); await expectText(p, /Connect Instagram/i); }],
    ['automations-starter-limit', async (p) => { await clickText(p, 'button', 'Add all three', { wait: 2500 }).catch(() => clickText(p, 'button', 'starter', { wait: 2500 })); }],
    ['upgrade-modal', async (p) => { await go(p, '/'); await clickText(p, 'button', 'Upgrade', { wait: 1500 }); await expectText(p, /Upgrade to Pro|Pro/); }],
    ['upgrade-paddle', async (p) => { await clickText(p, 'button', 'Upgrade to Pro', { wait: 7000 }); const fr = await p.evaluate(() => [...document.querySelectorAll('iframe')].some((f) => /paddle/.test(f.src))); if (!fr) throw new Error('no paddle iframe'); }],
    ['billing-trial', async (p) => { await go(p, '/billing'); await expectText(p, /Trial/); }],
    ['delete-account', async (p) => { const st = await p.evaluate(async () => (await fetch('/api/account', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE' }) })).status); if (st !== 200) throw new Error('delete ' + st); }],
  ]);
} finally { await browser.close(); }

for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.label.padEnd(6)} ${r.name.padEnd(26)} ${String(r.ms).padStart(6)}ms ${r.error || ''}${r.issues.length ? '\n' + r.issues.map((i) => '        · ' + i).join('\n') : ''}`);
console.log(`\n${results.filter((r) => !r.ok || r.issues.length).length} steps with findings out of ${results.length}`);
