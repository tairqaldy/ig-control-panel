/*
 * Resurfly Companion — the sync algorithm.
 *
 *   1. GET /api/companion/state → knownIds (newest 500 Instagram pks), total, quota.
 *   2. Walk https://www.instagram.com/api/v1/feed/saved/posts/?max_id=… with fetch(credentials:'include').
 *      The extension has the instagram.com host permission, so the user's own cookies travel along.
 *   3. Normalize with lib/core.js, buffer unknown items, POST /api/companion/harvest in chunks of ≤100.
 *   4. Stop rules:
 *        - first run (firstRunDone=false): no stop rule — walk the whole feed; the cursor is persisted in
 *          chrome.storage.local (`walk`) after every posted chunk so a killed service worker resumes.
 *        - later runs: stop after 3 consecutive pages that contain only known items.
 *        - every invocation walks at most MAX_PAGES_PER_RUN pages; if there is more, the walk state is kept
 *          and the caller schedules a follow-up (background.js does this with a 1-minute alarm).
 *   5. "Not logged in" (401/403, login redirect, HTML instead of JSON) → status 'login_required'.
 *
 * Nothing is sent when there is nothing new (no runId is opened, so no harvest quota is spent).
 */

import { IG_ORIGIN, savedFeedUrl, buildHeaders, pageItems, pageCursor, normalizeItem, looksLikeLoginPage } from './core.js';
import { ApiError } from './api.js';
import * as store from './store.js';

export const CHUNK_SIZE = 100;
export const MAX_PAGES_PER_RUN = 60;
export const KNOWN_PAGES_TO_STOP = 3;
const PAGE_DELAY_MS = [1000, 2000]; // jitter between Instagram requests
const IG_RETRIES = 4;

export class LoginRequired extends Error {
  constructor(msg = 'Instagram says you are not logged in.') { super(msg); this.name = 'LoginRequired'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = ([a, b]) => a + Math.random() * (b - a);

/** csrftoken cookie for the x-csrftoken header — only when the optional `cookies` permission is granted. */
export async function readCsrfToken() {
  try {
    if (typeof chrome === 'undefined' || !chrome.permissions) return null;
    const ok = await chrome.permissions.contains({ permissions: ['cookies'] });
    if (!ok || !chrome.cookies) return null;
    const c = await chrome.cookies.get({ url: 'https://www.instagram.com/', name: 'csrftoken' });
    return c && c.value ? c.value : null;
  } catch (e) {
    return null;
  }
}

/** Fetch one saved-feed page as JSON. Retries 429/5xx/network; throws LoginRequired when signed out. */
export async function fetchFeedPage(maxId, { csrftoken, signal, onWait } = {}) {
  const url = savedFeedUrl(maxId, IG_ORIGIN);
  const headers = buildHeaders({ csrftoken });
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: 'GET', headers, credentials: 'include', redirect: 'follow', signal });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      if (attempt >= IG_RETRIES) throw new Error(`Network error talking to Instagram (${e && e.message ? e.message : e}).`);
      const wait = 3000 * Math.pow(2, attempt);
      if (onWait) onWait(wait, 'network');
      await sleep(wait);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= IG_RETRIES) throw new Error(`Instagram responded ${res.status} repeatedly. Try again later.`);
      const ra = Number(res.headers.get('retry-after')) * 1000;
      const wait = ra > 0 ? Math.min(ra, 120000) : 20000 * (attempt + 1);
      if (onWait) onWait(wait, 'rate');
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    const loginRedirect = res.redirected && /\/accounts\/login/.test(String(res.url || ''));
    if (loginRedirect || looksLikeLoginPage(res.status, res.headers.get('content-type') || '', text)) throw new LoginRequired();
    if (!res.ok) throw new Error(`Instagram responded HTTP ${res.status}.`);
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new LoginRequired('Instagram returned something that is not JSON — are you logged in?');
    }
    if (data && data.status === 'fail' && /login/i.test(String(data.message || ''))) throw new LoginRequired();
    return data;
  }
}

/** One raw feed page → { items: HarvestItem[], nextMaxId, moreAvailable, rawCount }. Items that fail to normalize are skipped. */
export function parseFeedPage(data) {
  const medias = pageItems(data);
  const items = [];
  for (const m of medias) {
    try { items.push(normalizeItem(m, null)); } catch (e) { /* unexpected shape → skip */ }
  }
  const { more, nextMaxId } = pageCursor(data);
  return { items, nextMaxId, moreAvailable: more, rawCount: (data && Array.isArray(data.items)) ? data.items.length : 0 };
}

const empty = (status, extra = {}) => ({ status, newItems: 0, imported: 0, pages: 0, fetched: 0, sent: 0, finished: false, continueLater: false, ...extra });

/**
 * Run one sync.
 * @param {object} p
 * @param {ReturnType<import('./api.js').createClient>} p.client
 * @param {(msg: string, data?: object) => void} [p.onProgress]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<SyncResult>}
 *
 * SyncResult = { status: 'ok'|'partial'|'login_required'|'quota'|'unpaired'|'error',
 *                newItems, imported, pages, fetched, sent, finished: boolean, continueLater: boolean,
 *                quota?, error?: string }
 */
export async function runSync({ client, onProgress, signal }) {
  const log = (msg, data) => { try { if (onProgress) onProgress(msg, data); } catch (e) { /* ignore */ } };
  const st = await store.getAll();
  if (!st.token) return empty('unpaired', { finished: true });

  // 1. state
  let state;
  try {
    state = await client.state();
  } catch (e) {
    if (e instanceof ApiError && e.code === 'unauthorized') {
      await store.clearPairing();
      return empty('unpaired', { finished: true, error: 'This device was removed in Resurfly. Pair again to continue.' });
    }
    return empty('error', { error: e && e.message ? e.message : String(e) });
  }
  const knownIds = new Set((state && Array.isArray(state.knownIds) ? state.knownIds : []).map(String));
  await store.set({
    total: typeof state.total === 'number' ? state.total : (st.total || 0),
    lastHarvestAt: state.lastHarvestAt || null,
    harvestQuota: state.harvestQuota || null,
    serverHarvest: !!(state.serverHarvest && state.serverHarvest.enabled),
    serverHarvestStatus: state.serverHarvest ? (state.serverHarvest.status || null) : null,
    serverHarvestAvailable: !(state.serverHarvest && state.serverHarvest.available === false),
    minIntervalMinutes: Number(state.minIntervalMinutes) > 0 ? Number(state.minIntervalMinutes) : 360,
  });

  // 2. walk setup — resume an unfinished walk, else start a new one from the top of the feed
  const firstRun = !st.firstRunDone;
  const walk = st.walk && typeof st.walk === 'object' && typeof st.walk.cursor === 'string'
    ? { ...st.walk }
    : { cursor: '', runId: null, imported: 0, newItems: 0, pages: 0, startedAt: Date.now(), full: firstRun };
  const useStopRule = !walk.full; // first full walk has no stop rule
  const csrftoken = await readCsrfToken();

  const seen = new Set();
  const buffer = [];
  let cursor = walk.cursor; // next page to fetch (in memory); walk.cursor is the persisted resume point
  let pagesThisRun = 0;
  let fetched = 0;
  let sent = 0;
  let consecutiveKnown = 0;
  let finished = false;
  let continueLater = false;
  let lastQuota = null;

  const persistWalk = () => store.set({ walk, syncing: Date.now() });

  /** POST the buffer in ≤100 slices (last slice carries `done`), then advance the persisted cursor. */
  const flush = async (done, cursorAfter) => {
    if (!buffer.length && walk.runId == null) {
      // nothing was ever sent in this walk → do not open a run on the server (no quota spent)
      walk.cursor = cursorAfter;
      await persistWalk();
      return;
    }
    do {
      const slice = buffer.splice(0, CHUNK_SIZE);
      const isLast = buffer.length === 0;
      let res;
      try {
        res = await client.harvest({ items: slice, done: done && isLast, cursor: cursorAfter || undefined, runId: walk.runId || undefined });
      } catch (e) {
        // 409 bad_run: the server closed/abandoned our run (stale > 24 h, restart…) → open a new one and retry once
        if (e instanceof ApiError && e.status === 409 && walk.runId != null) {
          walk.baseImported = walk.imported; walk.baseNew = walk.newItems; walk.runId = null;
          res = await client.harvest({ items: slice, done: done && isLast, cursor: cursorAfter || undefined });
        } else throw e;
      }
      if (res && res.runId != null) walk.runId = res.runId;
      // the server reports run-cumulative counts (imported/newItems for the whole run), so assign, don't add
      walk.imported = (walk.baseImported || 0) + (Number(res && res.imported) || 0);
      walk.newItems = (walk.baseNew || 0) + (Number(res && res.newItems) || 0);
      if (res && res.quota) lastQuota = res.quota;
      sent += slice.length;
      log(`Sent ${sent} saves…`, { sent, newItems: walk.newItems });
    } while (buffer.length);
    walk.cursor = cursorAfter;
    await persistWalk();
  };

  try {
    // 3. pages
    for (;;) {
      if (signal && signal.aborted) break;
      if (pagesThisRun >= MAX_PAGES_PER_RUN) { continueLater = true; break; }
      const data = await fetchFeedPage(cursor, {
        csrftoken,
        signal,
        onWait: (ms, why) => log(why === 'rate' ? `Instagram asked us to slow down — waiting ${Math.round(ms / 1000)}s` : `Network hiccup — retrying in ${Math.round(ms / 1000)}s`),
      });
      pagesThisRun++;
      walk.pages = (walk.pages || 0) + 1;
      const page = parseFeedPage(data);
      fetched += page.items.length;
      let unknownOnPage = 0;
      for (const it of page.items) {
        const pk = String(it.pk || '');
        const key = pk || it.code;
        if (seen.has(key)) continue;
        seen.add(key);
        if (pk && knownIds.has(pk)) continue; // the server already has it
        buffer.push(it);
        unknownOnPage++;
      }
      log(`Read ${walk.pages} page${walk.pages === 1 ? '' : 's'} · ${buffer.length + sent} to send`, { pages: walk.pages, fetched });

      const nextCursor = page.moreAvailable ? page.nextMaxId : '';
      if (useStopRule) consecutiveKnown = page.rawCount > 0 && unknownOnPage === 0 ? consecutiveKnown + 1 : 0;
      const stopByRule = useStopRule && consecutiveKnown >= KNOWN_PAGES_TO_STOP;
      if (!page.moreAvailable || stopByRule) {
        finished = true;
        await flush(true, '');
        break;
      }
      if (buffer.length >= CHUNK_SIZE) await flush(false, nextCursor);
      else if (buffer.length === 0) { walk.cursor = nextCursor; await persistWalk(); }
      else await store.set({ syncing: Date.now() }); // extension API call → keeps the service worker alive
      cursor = nextCursor;
      await sleep(jitter(PAGE_DELAY_MS));
    }
    if (!finished && buffer.length) await flush(false, cursor); // out of page budget / aborted: ship what we have, keep the walk open
  } catch (e) {
    const partial = { newItems: walk.newItems, imported: walk.imported, pages: pagesThisRun, fetched, sent, finished: false, continueLater: false };
    if (e instanceof LoginRequired) {
      await store.set({ walk, syncing: 0 }); // resume later, once the user signs in again
      return { status: 'login_required', ...partial, error: e.message };
    }
    if (e instanceof ApiError && e.code === 'unauthorized') {
      await store.clearPairing();
      return { status: 'unpaired', ...partial, error: 'This device was removed in Resurfly. Pair again to continue.' };
    }
    if (e instanceof ApiError && e.code === 'quota') {
      await store.set({ walk, syncing: 0 }); // resume once the daily quota resets; the unsent buffer is re-fetched then
      return { status: 'quota', ...partial, quota: e.body || null, error: e.message };
    }
    await store.set({ walk, syncing: 0 });
    return { status: 'error', ...partial, error: e && e.message ? e.message : String(e) };
  }

  // 4. bookkeeping
  const result = {
    status: finished ? 'ok' : 'partial',
    newItems: walk.newItems,
    imported: walk.imported,
    pages: pagesThisRun,
    fetched,
    sent,
    finished,
    continueLater: !finished && (continueLater || !!(signal && signal.aborted)),
    quota: lastQuota,
  };
  if (finished) {
    await store.remove(['walk']);
    await store.set({ firstRunDone: true, syncing: 0 });
  } else {
    await store.set({ walk, syncing: 0 });
  }
  return result;
}
