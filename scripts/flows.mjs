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

async function withPage(browser, label, loginFn, steps, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const issues = [];
  page.on('pageerror', (e) => issues.push('pageerror: ' + String(e.message).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') issues.push('console: ' + m.text().slice(0, 200)); });
  page.on('response', (r) => { const s = r.status(); if (s >= 500) issues.push(`http ${s} ${r.request().method()} ${r.url().slice(0, 120)}`); });
  page.on('dialog', async (d) => { await d.accept(); });
  await page.setViewport({ ...viewport, isMobile: viewport.width < 768, hasTouch: viewport.width < 768 });
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
/** Status + parsed body of an API call made with the page's own session cookie. */
const apiGet = (page, url) => page.evaluate(async (u) => { const r = await fetch(u); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; }, url);
const expectNoOverflow = async (page) => { const px = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (px > 0) throw new Error(`page scrolls sideways by ${px}px`); };

const ownerLogin = async (page) => { const st = await page.evaluate(async (u, p) => (await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, passcode: p }) })).status, process.env.CAPTURE_USER, process.env.CAPTURE_PASS); if (st !== 200) throw new Error('owner login ' + st); };
let trialEmail = `flows-${Date.now()}@example.com`;
const trialSignup = async (page) => { const st = await page.evaluate(async (e) => (await fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: 'flows-passw0rd' }) })).status, trialEmail); if (st !== 200) throw new Error('signup ' + st); };

/**
 * ROUND7 §1: with a card required at signup, a fresh account is walled and EVERY app flow below would fail by design.
 * So ask the product which world we are in — one throwaway signup — and run the matching set. Guessing from env would
 * lie the moment TRIAL_REQUIRES_CARD turns itself off for a missing price id.
 */
async function detectPaywall(browser) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  let locked = false;
  try {
    await page.goto(base + '/login', { waitUntil: 'domcontentloaded' });
    const email = `flows-probe-${Date.now()}@example.com`;
    const st = await page.evaluate(async (e) => (await fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: 'flows-passw0rd' }) })).status, email);
    if (st === 200) {
      locked = await page.evaluate(async () => { try { return !!(await (await fetch('/api/paywall')).json()).locked; } catch { return false; } });
      await page.evaluate(async () => fetch('/api/account', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE' }) }));
    }
  } catch {}
  await ctx.close();
  return locked;
}

/** The card wall itself is the whole new-user experience when it is on, so it gets checked properly. */
const LOCKED_STEPS = [
  ['paywall-redirect', async (p) => { await go(p, '/'); if (!/\/start/.test(p.url())) throw new Error('a locked account was not sent to /start: ' + p.url()); }],
  ['paywall-copy', async (p) => { await expectText(p, /3 days free|three days free/i); await expectText(p, /card/i); }],
  ['paywall-price-and-date', async (p) => { await expectText(p, /\$19/); await expectText(p, /[A-Z][a-z]{2} \d|\d{1,2} [A-Z][a-z]{2}|charge/i); }],
  ['paywall-yearly', async (p) => { await clickText(p, 'button', 'year', { wait: 900 }).catch(() => {}); await expectText(p, /\$144|\$12/); }],
  ['paywall-402-shape', async (p) => {
    const r = await apiGet(p, '/api/items?limit=1');
    if (r.status !== 402) throw new Error('locked tenant got ' + r.status + ' from /api/items, expected 402');
    if (r.body?.code !== 'payment_required') throw new Error('402 body code=' + r.body?.code);
    if (r.body?.start !== '/start') throw new Error('402 body start=' + r.body?.start);
  }],
  ['paywall-open-routes', async (p) => {
    for (const u of ['/api/plan', '/api/plans', '/api/billing/credits']) {
      const r = await apiGet(p, u);
      if (r.status !== 200) throw new Error(`${u} answered ${r.status} while locked — a locked account cannot pay without it`);
    }
  }],
  ['paywall-checkout-opens', async (p) => {
    await go(p, '/start');
    await clickText(p, 'button', 'start 3 days free', { wait: 8000 }).catch(async () => { await clickText(p, 'button', 'free', { wait: 8000 }); });
    const fr = await p.evaluate(() => [...document.querySelectorAll('iframe')].some((f) => /paddle/.test(f.src)));
    if (!fr) throw new Error('no Paddle iframe after pressing the trial button');
  }],
  ['paywall-delete-account', async (p) => { const st = await p.evaluate(async () => (await fetch('/api/account', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE' }) })).status); if (st !== 200) throw new Error('a locked account could not delete itself: ' + st); }],
];

/** Screens 1-5 of the wizard, walked the way the founder's father would: nothing imported, nothing connected. */
const WIZARD_STEPS = [
  ['wizard-1-bring-saves', async (p) => { await go(p, '/welcome'); await expectText(p, /saves/i); }],
  ['wizard-1-one-action', async (p) => { const n = await p.evaluate(() => [...document.querySelectorAll('main button, main a[role="button"]')].filter((b) => b.offsetParent && /companion|upload|install|export/i.test(b.innerText)).length); if (n === 0) throw new Error('screen 1 offers no way to bring saves in'); }],
  ['wizard-2-watch', async (p) => { await go(p, '/welcome?step=2'); await expectText(p, /analy|waiting|saves/i); }],
  ['wizard-3-first-question', async (p) => { await go(p, '/welcome?step=3'); await expectText(p, /ask|question/i); }],
  ['wizard-4-instagram-honest', async (p) => {
    await go(p, '/welcome?step=4', 2500);
    const t = await p.evaluate(() => document.body.innerText);
    // Either connecting is possible and offered, or it is not and the screen says why — never a button that dies at Meta.
    const offers = /connect instagram/i.test(t);
    const explains = /review|not accepting|waiting|unavailable|checking/i.test(t);
    if (offers && !explains) {
      const av = await apiGet(p, '/api/instagram/availability');
      if (av.status === 200 && av.body && av.body.canConnect === false) throw new Error('screen 4 offers Connect while availability says canConnect=false');
    }
  }],
  ['wizard-5-done', async (p) => { await go(p, '/welcome?step=5'); await expectText(p, /done|set|ready|next/i); }],
  ['wizard-survives-reload', async (p) => { await go(p, '/welcome?step=3'); await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(1500); if (!/step=3/.test(p.url())) throw new Error('the wizard lost its place on reload: ' + p.url()); }],
];

const PROFILE_STEPS = [
  ['profile-score-empty', async (p) => { await go(p, '/profile-score', 2000); await expectText(p, /profile|score|bio/i); }],
  ['profile-questions', async (p) => { const r = await apiGet(p, '/api/profile/questions'); if (r.status !== 200) throw new Error('/api/profile/questions ' + r.status); if (!Array.isArray(r.body?.questions) || !r.body.questions.length) throw new Error('no questions returned'); }],
];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 90000, args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--lang=en-US'] });
const paywallLocked = await detectPaywall(browser);
console.log(`paywall: new signups are ${paywallLocked ? 'LOCKED — running the card-wall path' : 'not locked — running the wizard path'}\n`);
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
    ['automations-simulate', async (p) => { await go(p, '/automations'); await clickText(p, 'button', 'New rule', { wait: 1500 }); await clickText(p, 'button', 'Simulate', { wait: 2500 }); await expectText(p, /matched|no rule|would|listens for/i); }],
    ['import-pairing', async (p) => { await go(p, '/import'); await clickText(p, 'button', 'Get pairing code', { wait: 2000 }); await expectText(p, /RSF-/); }],
    ['settings-save', async (p) => { await go(p, '/settings'); await clickText(p, 'button', 'Save changes', { wait: 1500 }); }],
    ['graph-view', async (p) => { await go(p, '/graph', 3000); await clickText(p, 'button', 'View', { wait: 800 }); await expectText(p, /Everything|Map/); }],
    ['resurface-random', async (p) => { await go(p, '/resurface'); await clickText(p, 'button', 'Random save', { wait: 2000 }); }],
    ['palette', async (p) => { await go(p, '/'); await p.keyboard.down('Control'); await p.keyboard.press('k'); await p.keyboard.up('Control'); await sleep(600); await p.keyboard.type('analytics'); await sleep(600); await p.keyboard.press('Enter'); await sleep(1500); if (!/\/analytics/.test(p.url())) throw new Error('palette nav failed: ' + p.url()); }],
    ['billing', async (p) => { await go(p, '/billing'); await expectText(p, /Studio/); }],
  ]);
  if (paywallLocked) {
    await withPage(browser, 'locked', trialSignup, LOCKED_STEPS);
    trialEmail = `flows-${Date.now()}-m@example.com`;
    await withPage(browser, 'locked-phone', trialSignup, [
      ['paywall-phone', async (p) => { await go(p, '/start', 2000); await expectNoOverflow(p); await expectText(p, /3 days free|three days free/i); }],
      ['paywall-phone-cleanup', async (p) => { await p.evaluate(async () => fetch('/api/account', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE' }) })); }],
    ], { width: 390, height: 844 });
  } else {
  await withPage(browser, 'trial', trialSignup, [
    ['welcome-1', async (p) => { await go(p, '/'); if (!/\/welcome/.test(p.url())) throw new Error('no redirect to welcome: ' + p.url()); await expectText(p, /Bring your saves/i); }],
    ['welcome-pair', async (p) => { await clickText(p, 'button, a', 'companion', { wait: 1500 }).catch(() => {}); await clickText(p, 'button', 'pairing code', { wait: 2500 }).catch(() => clickText(p, 'button', 'pair', { wait: 2500 })); await expectText(p, /RSF-/); }],
    ['welcome-2', async (p) => { await go(p, '/welcome?step=2'); await expectText(p, /analy|Waiting|Start/i); }],
    ['welcome-3', async (p) => { await go(p, '/welcome?step=3'); await expectText(p, /Ask/i); }],
    ['ask-quota-pill', async (p) => { await go(p, '/ask'); await expectText(p, /20 questions|\/ 20/i); }],
    ['ask-empty-library', async (p) => { const ta = await p.$('main textarea'); await ta.click(); await p.keyboard.type('hello?'); await p.keyboard.press('Enter'); await sleep(6000); }],
    ['analytics-demo', async (p) => { await go(p, '/analytics'); await expectText(p, /Sample|sample|demo/i); }],
    ['automations-honest-about-instagram', async (p) => {
      await go(p, '/automations', 2500);
      const av = await apiGet(p, '/api/instagram/availability');
      const t = await p.evaluate(() => document.body.innerText);
      if (av.status === 200 && av.body && av.body.canConnect === false) {
        // Nothing on this page may offer a connection that ends on Meta's error page.
        const link = await p.evaluate(() => [...document.querySelectorAll('a[href], button')].some((el) => el.offsetParent && /connect instagram/i.test(el.innerText || '')));
        if (link) throw new Error('a Connect Instagram control is offered while canConnect=false');
        if (!/review|waiting|not accepting|development|unavailable/i.test(t)) throw new Error('no explanation of why Instagram cannot be connected');
      } else if (!/connect instagram/i.test(t)) {
        throw new Error('connecting is possible but the page does not offer it');
      }
    }],
    ['automations-templates', async (p) => { await go(p, '/automations', 2000); await expectText(p, /template|pick a behaviour|start here|comment|story reply/i); }],
    ['upgrade-modal', async (p) => { await go(p, '/'); await clickText(p, 'button', 'Upgrade', { wait: 1500 }); await expectText(p, /Upgrade to Pro|Pro/); }],
    ['upgrade-paddle', async (p) => { await clickText(p, 'button', 'Upgrade to Pro', { wait: 7000 }); const fr = await p.evaluate(() => [...document.querySelectorAll('iframe')].some((f) => /paddle/.test(f.src))); if (!fr) throw new Error('no paddle iframe'); }],
    ['billing-trial', async (p) => { await go(p, '/billing'); await expectText(p, /Trial/); }],
    ['delete-account', async (p) => { const st = await p.evaluate(async () => (await fetch('/api/account', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE' }) })).status); if (st !== 200) throw new Error('delete ' + st); }],
  ]);
  }

  // The wizard and the profile score are walked as the owner: they work with a real library and need no card.
  await withPage(browser, 'wizard', ownerLogin, WIZARD_STEPS);
  await withPage(browser, 'wizard-phone', ownerLogin, WIZARD_STEPS, { width: 390, height: 844 });
  await withPage(browser, 'profile', ownerLogin, PROFILE_STEPS);
} finally { await browser.close(); }

for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.label.padEnd(6)} ${r.name.padEnd(26)} ${String(r.ms).padStart(6)}ms ${r.error || ''}${r.issues.length ? '\n' + r.issues.map((i) => '        · ' + i).join('\n') : ''}`);
console.log(`\n${results.filter((r) => !r.ok || r.issues.length).length} steps with findings out of ${results.length}`);
