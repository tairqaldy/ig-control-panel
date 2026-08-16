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
import { createRequire } from 'node:module';
const ffmpegPath = createRequire(import.meta.url)('ffmpeg-static');
process.env.PATH = path.dirname(ffmpegPath) + path.delimiter + process.env.PATH;

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
  await Promise.race([page.evaluate(() => document.fonts?.ready?.then(() => 1)), sleep(3000)]).catch(() => {});
  await sleep(ms);
}

async function shot(page, file) {
  const buf = await page.screenshot({ type: 'png' });
  await sharp(buf).resize({ width: W * 2, height: H * 2, fit: 'cover' }).jpeg({ quality: 88, mozjpeg: true }).toFile(file);
  console.log('shot', path.basename(file));
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', protocolTimeout: 240000, args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb', '--lang=en-US'] });
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
      ['ask', '/ask?q=' + encodeURIComponent('What did I save about hooks for short videos? Keep it to five points.')],
      ['graph', '/graph'],
      ['automations', '/automations'],
      ['analytics', '/analytics'],
      ['import', '/import'],
      ['resurface', '/resurface'],
    ];
    for (const [name, url] of targets) {
      await page.goto(base + url, { waitUntil: 'domcontentloaded' });
      await settle(page, name === 'ask' ? 5500 : name === 'graph' ? 4500 : 1500);
      if (name === 'ask') await page.evaluate(() => { const m = document.querySelector('main'); (m?.querySelector('[data-scroll], .overflow-y-auto') || m)?.scrollTo?.(0, 0); window.scrollTo(0, 0); });
      await shot(page, path.join(outDir, name + '.jpg'));
    }
    // a save opened in the modal (first library card)
    await page.goto(base + '/library', { waitUntil: 'domcontentloaded' });
    await settle(page, 1500);
    const card = await page.$('article, [data-item-id], .item-card, main a[href*="/library"], main button');
    if (card) { try { await card.click(); await settle(page, 1800); await shot(page, path.join(outDir, 'save.jpg')); } catch (e) { console.warn('save modal shot skipped', e.message); } }
  }

  if (mode === 'clip') {
    fs.mkdirSync(outDir, { recursive: true });
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    const file = path.join(outDir, clipName + '.webm');
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await setTheme(page, 'dark');
    const go = async (url, ms) => { await page.goto(base + url, { waitUntil: 'domcontentloaded' }); await settle(page, ms); };
    let recorder = null;
    const start = async () => { recorder = await page.screencast({ path: file, fps: 30 }); await sleep(600); };
    if (clipName === 'ask') {
      await go('/ask', 1500); await start();
      const ta = await page.$('main textarea');
      if (!ta) throw new Error('no composer textarea');
      await ta.click(); await sleep(400);
      await page.keyboard.type('What did I save about hooks for short videos?', { delay: 55 }); await sleep(500);
      await page.keyboard.press('Enter'); await sleep(12000);
    } else if (clipName === 'graph') {
      await go('/graph', 2500); await start();
      await page.mouse.move(720, 460); await sleep(600); await page.mouse.wheel({ deltaY: -350 }); await sleep(1500); await page.mouse.move(780, 430, { steps: 25 }); await sleep(2500);
    } else if (clipName === 'library') {
      await go('/library', 1500); await start();
      await page.mouse.move(700, 500); for (let i = 0; i < 6; i++) { await page.mouse.wheel({ deltaY: 220 }); await sleep(380); } await sleep(600);
    } else {
      await go('/' + clipName, 1500); await start(); await sleep(4000);
    }
    await recorder.stop(); await sleep(500);
    console.log('clip', clipName, '→', file, (fs.statSync(file).size / 1024).toFixed(0) + ' KB');
  }
} finally {
  await browser.close();
}
