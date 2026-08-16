#!/usr/bin/env node
/**
 * Headless captures for the landing page: dark UI screenshots, title cards and short video clips.
 *
 *   node scripts/capture.mjs shots  <baseUrl> <outDir> [dark|light]     # → outDir/{overview,ask,library,graph,automations,analytics,save,import}.jpg (1440×900)
 *   node scripts/capture.mjs cards  <baseUrl> <outDir>                  # → outDir/card-open.jpg, card-close.jpg from /landing/cards.html
 *   node scripts/capture.mjs clip   <baseUrl> <outDir> <name>           # → outDir/<name>/frame-0001.jpg … (10 fps) for scripted interactions
 *
 * Auth: APP_USERNAME/APP_PASSCODE from .env (or CAPTURE_USER/CAPTURE_PASS env). Uses the local Chrome via puppeteer-core.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const [mode, base, outDir, clipName] = process.argv.slice(2);
if (!mode || !base || !outDir) { console.error('usage: capture.mjs shots|cards|clip <baseUrl> <outDir> [name]'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const env = Object.fromEntries((fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const USER = process.env.CAPTURE_USER || env.APP_USERNAME;
const PASS = process.env.CAPTURE_PASS || env.APP_PASSCODE;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const W = 1440, H = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(page) {
  const res = await page.evaluate(async (u, p) => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, passcode: p }) });
    return r.status;
  }, USER, PASS);
  if (res !== 200) throw new Error('login failed: ' + res);
}

async function setTheme(page, theme) {
  await page.evaluate((t) => { try { localStorage.setItem('rs-theme', t); localStorage.setItem('theme', t); } catch {} document.documentElement.classList.toggle('dark', t === 'dark'); document.documentElement.dataset.theme = t; }, theme);
}

async function settle(page, ms = 1200) {
  try { await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }); } catch {}
  await page.evaluate(() => document.fonts?.ready);
  await sleep(ms);
}

async function shot(page, file) {
  const buf = await page.screenshot({ type: 'png' });
  await sharp(buf).resize({ width: W * 2, height: H * 2, fit: 'cover' }).jpeg({ quality: 88, mozjpeg: true }).toFile(file);
  console.log('shot', path.basename(file));
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb', '--lang=en-US'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  await page.goto(base + '/login', { waitUntil: 'domcontentloaded' });
  await login(page);

  if (mode === 'cards') {
    await page.goto(base + '/landing/cards.html', { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready); await sleep(500);
    for (const [id, name] of [['c1', 'card-open'], ['c2', 'card-close']]) {
      const el = await page.$('#' + id);
      const buf = await el.screenshot({ type: 'png' });
      await sharp(buf).resize({ width: W * 2, height: H * 2, fit: 'cover' }).jpeg({ quality: 90, mozjpeg: true }).toFile(path.join(outDir, name + '.jpg'));
      console.log('card', name);
    }
  }

  if (mode === 'shots') {
    const theme = process.argv[5] || 'dark';
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await setTheme(page, theme);
    const targets = [
      ['overview', '/'],
      ['library', '/library'],
      ['ask', '/ask?q=' + encodeURIComponent('What did I save about storytelling for short videos?')],
      ['graph', '/graph'],
      ['automations', '/automations'],
      ['analytics', '/analytics'],
      ['import', '/import'],
      ['resurface', '/resurface'],
    ];
    for (const [name, url] of targets) {
      await page.goto(base + url, { waitUntil: 'domcontentloaded' });
      await settle(page, name === 'ask' ? 9000 : name === 'graph' ? 4500 : 1500);
      await shot(page, path.join(outDir, name + '.jpg'));
    }
    // a save opened in the modal (first library card)
    await page.goto(base + '/library', { waitUntil: 'domcontentloaded' });
    await settle(page, 1500);
    const card = await page.$('article, [data-item-id], .item-card, main a[href*="/library"], main button');
    if (card) { try { await card.click(); await settle(page, 1800); await shot(page, path.join(outDir, 'save.jpg')); } catch (e) { console.warn('save modal shot skipped', e.message); } }
  }

  if (mode === 'clip') {
    const dir = path.join(outDir, clipName); fs.mkdirSync(dir, { recursive: true });
    let n = 0; let recording = true;
    const frames = [];
    const rec = (async () => { while (recording) { const t = Date.now(); const buf = await page.screenshot({ type: 'jpeg', quality: 82 }); frames.push(buf); n++; const dt = Date.now() - t; await sleep(Math.max(0, 100 - dt)); } })();
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await setTheme(page, 'dark');
    if (clipName === 'ask') {
      await page.goto(base + '/ask', { waitUntil: 'domcontentloaded' }); await settle(page, 1200);
      const ta = await page.$('textarea, input[type="text"]');
      if (ta) { await ta.click(); await page.keyboard.type('What did I save about hooks for short videos?', { delay: 45 }); await sleep(400); await page.keyboard.press('Enter'); await sleep(11000); }
    } else if (clipName === 'graph') {
      await page.goto(base + '/graph', { waitUntil: 'domcontentloaded' }); await settle(page, 2000);
      await page.mouse.move(700, 450); await sleep(500); await page.mouse.wheel({ deltaY: -300 }); await sleep(1500); await page.mouse.move(760, 420, { steps: 20 }); await sleep(2500);
    } else if (clipName === 'library') {
      await page.goto(base + '/library', { waitUntil: 'domcontentloaded' }); await settle(page, 1200);
      await page.mouse.move(700, 500); for (let i = 0; i < 6; i++) { await page.mouse.wheel({ deltaY: 220 }); await sleep(350); }
    } else if (clipName === 'welcome') {
      await page.goto(base + '/welcome?step=2', { waitUntil: 'domcontentloaded' }); await settle(page, 4000);
    } else {
      await page.goto(base + '/' + clipName, { waitUntil: 'domcontentloaded' }); await settle(page, 4000);
    }
    recording = false; await rec;
    frames.forEach((b, i) => fs.writeFileSync(path.join(dir, `frame-${String(i + 1).padStart(4, '0')}.jpg`), b));
    console.log('clip', clipName, n, 'frames →', dir);
  }
} finally {
  await browser.close();
}
