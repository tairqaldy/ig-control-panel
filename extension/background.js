/*
 * Resurfly Companion — background service worker (Manifest V3, ES module).
 *
 * - alarm 'resurfly-sync' every 6 h → syncNow('alarm')
 * - alarm 'resurfly-continue' (1 min) → resumes a walk that ran out of page budget
 * - alarm 'resurfly-badge' → clears the "N new" badge after 24 h
 * - messages from popup/options: getStatus · syncNow · pair · unpair · setServerHarvest · setAppUrl · refreshState
 *
 * All network calls to Resurfly and Instagram happen here so the device token never leaves this file's storage.
 */

import { pair as apiPair, createClient, ApiError, normalizeAppUrl } from './lib/api.js';
import { runSync } from './lib/sync.js';
import * as store from './lib/store.js';

const SYNC_ALARM = 'resurfly-sync';
const CONTINUE_ALARM = 'resurfly-continue';
const BADGE_ALARM = 'resurfly-badge';
const SYNC_PERIOD_MIN = 360;
const LOCK_STALE_MS = 15 * 60 * 1000;
const BADGE_TTL_MS = 24 * 60 * 60 * 1000;
const COLOR_JADE = '#2f9e77';
const COLOR_WARN = '#b7791f';

/* ---------------- in-memory run state (popup polls it) ---------------- */
let current = { running: false, text: '', startedAt: 0, reason: '' };

function broadcast(msg) {
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) { /* no listener */ }
}

/* ---------------- badge ---------------- */
async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text: text || '' });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ color: color || COLOR_JADE });
      if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
    }
  } catch (e) { /* ignore */ }
}

async function showNewBadge(n) {
  if (!n) return;
  await setBadge(n > 999 ? '999+' : String(n), COLOR_JADE);
  const until = Date.now() + BADGE_TTL_MS;
  await store.set({ badgeUntil: until });
  chrome.alarms.create(BADGE_ALARM, { when: until });
}

async function restoreBadge() {
  const { badgeUntil, lastSyncStatus, lastSyncNew, token } = await store.get(['badgeUntil', 'lastSyncStatus', 'lastSyncNew', 'token']);
  if (!token) return setBadge('');
  if (lastSyncStatus === 'login_required') return setBadge('!', COLOR_WARN);
  if (badgeUntil && badgeUntil > Date.now() && lastSyncNew > 0) return setBadge(lastSyncNew > 999 ? '999+' : String(lastSyncNew), COLOR_JADE);
  return setBadge('');
}

/* ---------------- helpers ---------------- */
function deviceName() {
  const ua = navigator.userAgent || '';
  const uad = navigator.userAgentData;
  let os = (uad && uad.platform) || '';
  if (!os) {
    if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
    else if (/CrOS/i.test(ua)) os = 'ChromeOS';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/Linux/i.test(ua)) os = 'Linux';
  }
  let browser = 'Chrome';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Brave/.test(ua) || (navigator.brave)) browser = 'Brave';
  else if (/Vivaldi/.test(ua)) browser = 'Vivaldi';
  return os ? `${browser} on ${os}` : browser;
}

async function getClient() {
  const { appUrl, token } = await store.getAll();
  if (!token) return null;
  return createClient({ appUrl, token });
}

async function ensureAlarms() {
  const a = await chrome.alarms.get(SYNC_ALARM);
  if (!a) chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MIN, delayInMinutes: 1 });
}

/* ---------------- sync ---------------- */
export async function syncNow(reason = 'manual') {
  const st = await store.getAll();
  if (!st.token) return { status: 'unpaired' };
  if (current.running) return { status: 'busy' };
  if (st.syncing && Date.now() - st.syncing < LOCK_STALE_MS && reason !== 'manual') return { status: 'busy' };
  if (reason === 'alarm' && st.lastSyncAt && st.lastSyncStatus === 'ok' && !st.walk) {
    const minMs = (Number(st.minIntervalMinutes) || SYNC_PERIOD_MIN) * 60 * 1000;
    if (Date.now() - st.lastSyncAt < minMs - 60 * 1000) return { status: 'skipped' };
  }

  current = { running: true, text: 'Checking Resurfly…', startedAt: Date.now(), reason };
  await store.set({ syncing: Date.now() });
  broadcast({ type: 'sync:started', reason });
  const client = createClient({ appUrl: st.appUrl, token: st.token });
  let result;
  try {
    result = await runSync({
      client,
      onProgress: (text) => { current.text = text; broadcast({ type: 'sync:progress', text }); },
    });
  } catch (e) {
    result = { status: 'error', newItems: 0, imported: 0, pages: 0, fetched: 0, sent: 0, finished: false, continueLater: false, error: e && e.message ? e.message : String(e) };
  }
  current = { running: false, text: '', startedAt: 0, reason: '' };

  const patch = {
    syncing: 0,
    lastSyncAt: Date.now(),
    lastSyncStatus: result.status,
    lastSyncError: result.error || '',
    lastSyncNew: result.newItems || 0,
    lastSyncImported: result.imported || 0,
  };
  await store.set(patch);

  // refresh the server-side total after we sent something (cheap, one GET)
  if (result.sent > 0 && result.status !== 'unpaired') {
    try {
      const s = await client.state();
      await store.set({ total: typeof s.total === 'number' ? s.total : undefined, harvestQuota: s.harvestQuota || null, lastHarvestAt: s.lastHarvestAt || null });
    } catch (e) { /* ignore */ }
  }

  if (result.status === 'login_required') await setBadge('!', COLOR_WARN);
  else if (result.status === 'unpaired') await setBadge('');
  else if (result.newItems > 0) await showNewBadge(result.newItems);
  else if (result.status === 'ok') await setBadge('');

  if (result.continueLater) chrome.alarms.create(CONTINUE_ALARM, { delayInMinutes: 1 });
  broadcast({ type: 'sync:done', result });
  return result;
}

/* ---------------- pairing / settings ---------------- */
async function doPair({ code, appUrl }) {
  const st = await store.getAll();
  const base = normalizeAppUrl(appUrl || st.appUrl);
  if (!base) throw new ApiError('Enter a valid Resurfly URL (https://…).');
  const origin = store.originPattern(base);
  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (!granted) throw new ApiError(`Allow the extension to reach ${new URL(base).host} first (Options → App URL).`, { code: 'permission' });
  const name = deviceName();
  const res = await apiPair(base, { code, name, ua: navigator.userAgent });
  if (!res || !res.token) throw new ApiError('Pairing did not return a token.');
  await store.clearPairing();
  await store.set({
    appUrl: normalizeAppUrl(res.appUrl) || base,
    token: res.token,
    tenantId: res.tenantId,
    deviceName: name,
    pairedAt: Date.now(),
    firstRunDone: false,
    lastSyncStatus: '',
    lastSyncNew: 0,
  });
  await ensureAlarms();
  // first sync right away (do not block the popup on it)
  setTimeout(() => { syncNow('pair').catch(() => {}); }, 50);
  return { ok: true, tenantId: res.tenantId, appUrl: normalizeAppUrl(res.appUrl) || base, deviceName: name };
}

async function doUnpair() {
  const client = await getClient();
  const { serverHarvest } = await store.get(['serverHarvest']);
  if (client && serverHarvest) { try { await client.clearSession(); } catch (e) { /* best effort */ } }
  await store.clearPairing();
  await setBadge('');
  chrome.alarms.clear(CONTINUE_ALARM);
  return { ok: true };
}

/** Opt in/out of server-side harvesting. The popup must have obtained the `cookies` permission (user gesture) first. */
async function doSetServerHarvest({ enabled }) {
  const client = await getClient();
  if (!client) throw new ApiError('Not paired.', { code: 'unpaired' });
  if (!enabled) {
    await client.clearSession();
    await store.set({ serverHarvest: false, serverHarvestStatus: null });
    return { ok: true, enabled: false };
  }
  const has = await chrome.permissions.contains({ permissions: ['cookies'] });
  if (!has || !chrome.cookies) throw new ApiError('The cookies permission was not granted.', { code: 'permission' });
  const get = (name) => chrome.cookies.get({ url: 'https://www.instagram.com/', name }).then((c) => (c && c.value) || null);
  const [sessionid, csrftoken, ds_user_id] = await Promise.all([get('sessionid'), get('csrftoken'), get('ds_user_id')]);
  if (!sessionid || !ds_user_id) throw new ApiError('You are not logged in to instagram.com in this browser. Log in, then try again.', { code: 'login_required' });
  await client.setSession({ sessionid, csrftoken: csrftoken || '', ds_user_id, ua: navigator.userAgent, enabled: true });
  await store.set({ serverHarvest: true, serverHarvestStatus: 'ok' });
  return { ok: true, enabled: true };
}

async function doSetAppUrl({ url }) {
  const base = normalizeAppUrl(url);
  if (!base) throw new ApiError('Enter a valid URL (https://…).');
  const { token } = await store.get(['token']);
  if (token) throw new ApiError('Remove the current pairing before changing the app URL.');
  await store.set({ appUrl: base });
  return { ok: true, appUrl: base };
}

async function getStatus() {
  const st = await store.getAll();
  const originOk = st.appUrl ? await chrome.permissions.contains({ origins: [store.originPattern(st.appUrl)] }) : false;
  const cookiesOk = await chrome.permissions.contains({ permissions: ['cookies'] });
  return {
    ...st,
    token: undefined,
    paired: !!st.token,
    originGranted: originOk,
    cookiesGranted: cookiesOk,
    running: current.running,
    progressText: current.text,
    version: chrome.runtime.getManifest().version,
  };
}

async function refreshState() {
  const client = await getClient();
  if (!client) return { ok: false };
  try {
    const s = await client.state();
    await store.set({
      total: typeof s.total === 'number' ? s.total : undefined,
      harvestQuota: s.harvestQuota || null,
      lastHarvestAt: s.lastHarvestAt || null,
      serverHarvest: !!(s.serverHarvest && s.serverHarvest.enabled),
      serverHarvestStatus: s.serverHarvest ? (s.serverHarvest.status || null) : null,
      serverHarvestAvailable: !(s.serverHarvest && s.serverHarvest.available === false),
      minIntervalMinutes: Number(s.minIntervalMinutes) > 0 ? Number(s.minIntervalMinutes) : SYNC_PERIOD_MIN,
    });
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError && e.code === 'unauthorized') { await store.clearPairing(); await setBadge(''); return { ok: false, unpaired: true }; }
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/* ---------------- events ---------------- */
chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureAlarms();
  await restoreBadge();
  if (details.reason === 'install') {
    // onboarding: the options page explains pinning + pairing
    try { await chrome.tabs.create({ url: chrome.runtime.getURL('options.html?welcome=1') }); } catch (e) { /* ignore */ }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarms();
  await restoreBadge();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SYNC_ALARM) await syncNow('alarm');
  else if (alarm.name === CONTINUE_ALARM) await syncNow('continue');
  else if (alarm.name === BADGE_ALARM) { const { lastSyncStatus } = await store.get(['lastSyncStatus']); if (lastSyncStatus !== 'login_required') await setBadge(''); }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p) => sendResponse(p);
  const fail = (e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e), code: e && e.code ? e.code : 'error' });
  (async () => {
    switch (msg && msg.type) {
      case 'getStatus': return reply(await getStatus());
      case 'syncNow': return reply(await syncNow('manual'));
      case 'pair': return reply(await doPair(msg));
      case 'unpair': return reply(await doUnpair());
      case 'setServerHarvest': return reply(await doSetServerHarvest(msg));
      case 'setAppUrl': return reply(await doSetAppUrl(msg));
      case 'refreshState': return reply(await refreshState());
      default: return reply({ ok: false, error: 'unknown message' });
    }
  })().catch(fail);
  return true; // async response
});

// keep the alarm/badge in shape when the worker wakes up for any reason
ensureAlarms().catch(() => {});
restoreBadge().catch(() => {});
