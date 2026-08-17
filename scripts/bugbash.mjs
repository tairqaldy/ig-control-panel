#!/usr/bin/env node
/**
 * Headless bug bash: visit every page as the owner and as a fresh trial user, at desktop + mobile,
 * collect console errors / page errors / failed requests, save screenshots, print a report.
 *
 *   CAPTURE_USER=… CAPTURE_PASS=… node scripts/bugbash.mjs https://resurfly.com <outDir> [owner|trial|both]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const [base, outDir, who = 'both'] = process.argv.slice(2);
if (!base || !outDir) { console.error('usage'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROUTES = ['/', '/library', '/ask', '/resurface', '/graph', '/analytics', '/automations', '/profile-score', '/import', '/settings', '/billing', '/welcome'];
// Every page a reviewer (Meta, Chrome Web Store) or a customer can reach without an account.
const PUBLIC = ['/', '/pricing', '/privacy', '/privacy/extension', '/terms', '/refunds', '/credits-terms', '/security', '/data-deletion', '/subprocessors', '/dpa', '/login', '/signup'];
const VIEWPORTS = [['desktop', 1440, 900], ['mobile', 390, 844]];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 90000, args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--lang=en-US'] });
const report = [];
async function sweep(label, routes, loginFn) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const issues = [];
  page.on('pageerror', (e) => issues.push({ kind: 'pageerror', msg: String(e.message).slice(0, 300) }));
  page.on('console', (m) => { if (m.type() === 'error') issues.push({ kind: 'console', msg: m.text().slice(0, 300) }); });
  page.on('response', (r) => { const s = r.status(); const u = r.url(); if (s >= 400 && s !== 402 && s !== 401 && !/favicon|hot-update|sockjs/.test(u)) issues.push({ kind: 'http', msg: `${s} ${r.request().method()} ${u.slice(0, 160)}` }); });
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(base + '/login', { waitUntil: 'domcontentloaded' });
  if (loginFn) await loginFn(page);
  for (const [vp, w, h] of VIEWPORTS) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: vp === 'mobile', hasTouch: vp === 'mobile' });
    for (const route of routes) {
      const before = issues.length;
      const t0 = Date.now();
      try {
        await page.goto(base + route, { waitUntil: 'domcontentloaded' });
        try { await page.waitForNetworkIdle({ idleTime: 600, timeout: 6000 }); } catch {}
        await sleep(route === '/graph' ? 3000 : 900);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        const text = await page.evaluate(() => document.body.innerText.length);
        const landed = new URL(page.url()).pathname;
        const name = `${label}-${vp}${route === '/' ? '-home' : route.replace(/\//g, '-')}.png`;
        await page.screenshot({ path: path.join(outDir, name), fullPage: vp === 'mobile' ? false : false });
        const mine = issues.slice(before);
        report.push({ label, vp, route, landed, ms: Date.now() - t0, overflow, textLen: text, issues: mine });
      } catch (e) {
        report.push({ label, vp, route, error: String(e.message).slice(0, 200), issues: issues.slice(before) });
      }
    }
  }
  await ctx.close();
}

const ownerLogin = async (page) => { const st = await page.evaluate(async (u, p) => (await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, passcode: p }) })).status, process.env.CAPTURE_USER, process.env.CAPTURE_PASS); if (st !== 200) throw new Error('owner login ' + st); };
let trialEmail = null;
const trialSignup = async (page) => { trialEmail = `bugbash-${Date.now()}@example.com`; const st = await page.evaluate(async (e) => (await fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: 'bugbash-passw0rd' }) })).status, trialEmail); if (st !== 200) throw new Error('signup ' + st); };
const trialCleanup = async () => { const ctx = await browser.createBrowserContext(); const page = await ctx.newPage(); await page.goto(base + '/login', { waitUntil: 'domcontentloaded' }); await page.evaluate(async (e) => { await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: 'bugbash-passw0rd' }) }); await fetch('/api/account', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE' }) }); }, trialEmail); await ctx.close(); };

/**
 * Is a brand-new account walled behind the card (ROUND7 §1)? Asked once from a throwaway signup, because the answer
 * changes what "correct" means for the fresh-account persona: with the paywall on, every app route MUST bounce to
 * /start, and a route that renders instead is a hole in the wall.
 */
let lockedPersona = false;
async function detectPaywall() {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  try {
    await page.goto(base + '/login', { waitUntil: 'domcontentloaded' });
    const email = `bugbash-probe-${Date.now()}@example.com`;
    const st = await page.evaluate(async (e) => (await fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: 'bugbash-passw0rd' }) })).status, email);
    if (st === 200) {
      lockedPersona = await page.evaluate(async () => { try { return !!(await (await fetch('/api/paywall')).json()).locked; } catch { return false; } });
      await page.evaluate(async () => fetch('/api/account', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE' }) }));
    }
  } catch {}
  await ctx.close();
  console.log(`paywall: new signups are ${lockedPersona ? 'LOCKED — expecting every app route to land on /start' : 'not locked'}`);
}

try {
  await detectPaywall();
  await sweep('public', PUBLIC, null);
  if (who === 'owner' || who === 'both') await sweep('owner', ROUTES, ownerLogin);
  if (who === 'trial' || who === 'both') { await sweep(lockedPersona ? 'locked' : 'trial', ROUTES, trialSignup); await trialCleanup(); }
} finally { await browser.close(); }

// report
// A locked account that reaches anything other than /start has slipped past the paywall.
const strayed = (r) => r.label === 'locked' && r.landed && r.landed !== '/start';
const bad = report.filter((r) => r.error || r.issues.length || strayed(r) || (r.overflow > 0 && r.vp === 'mobile'));
for (const r of report) {
  const flag = r.error ? 'ERR ' : r.issues.length ? 'ISSUE' : strayed(r) ? 'LEAK' : r.overflow > 0 && r.vp === 'mobile' ? 'OVERFLOW' : 'ok ';
  console.log(`${flag.padEnd(8)} ${r.label.padEnd(6)} ${r.vp.padEnd(7)} ${r.route.padEnd(13)} ${String(r.ms || '').padStart(5)}ms overflow=${r.overflow ?? '-'} text=${r.textLen ?? '-'}${strayed(r) ? ' landed=' + r.landed : ''}${r.error ? ' ' + r.error : ''}`);
  for (const i of r.issues) console.log(`         · ${i.kind}: ${i.msg}`);
}
console.log(`\n${bad.length} pages with findings out of ${report.length}. Screenshots in ${outDir}`);
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
