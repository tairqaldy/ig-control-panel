/* Resurfly Companion — popup. Talks to background.js via runtime messages; no network calls here
   except none: pairing, syncing and the opt-in all run in the service worker. */

import { originPattern } from './lib/store.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const els = {
  loading: $('view-loading'),
  unpaired: $('view-unpaired'),
  paired: $('view-paired'),
  code: $('code'),
  btnPair: $('btn-pair'),
  pairError: $('pair-error'),
  pairOrigin: $('pair-origin'),
  pairOriginHost: $('pair-origin-host'),
  btnGrantOrigin: $('btn-grant-origin'),
  appHost: $('app-host'),
  linkChangeUrl: $('link-change-url'),
  changeUrlWrap: $('change-url-wrap'),
  newSince: $('new-since'),
  status: $('status'),
  statusText: $('status-text'),
  statLast: $('stat-last'),
  statNew: $('stat-new'),
  statTotal: $('stat-total'),
  notice: $('notice'),
  btnSync: $('btn-sync'),
  syncLabel: $('sync-label'),
  linkOpen: $('link-open'),
  toggleWrap: $('toggle-wrap'),
  toggle: $('toggle-server'),
  serverNotice: $('server-notice'),
  deviceName: $('device-name'),
  version: $('version'),
  btnOptions: $('btn-options'),
  linkOptions: $('link-options'),
};

let status = null;
let pollTimer = null;

/* Store builds ship without optional_host_permissions, so there is no second origin to point the extension at
   and the "change app URL" affordance is hidden. Self-hosted (unpacked) builds keep it. */
const SELF_HOSTABLE = (() => {
  try {
    const m = chrome.runtime.getManifest();
    return Array.isArray(m.optional_host_permissions) && m.optional_host_permissions.length > 0;
  } catch (e) { return false; }
})();
if (!SELF_HOSTABLE && els.changeUrlWrap) els.changeUrlWrap.classList.add('hidden');

function fmtAgo(ms) {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  if (d < 45 * 1000) return 'just now';
  const m = Math.round(d / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
const fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');
const host = (url) => { try { return new URL(url).host; } catch (e) { return url || ''; } };

function show(view) {
  els.loading.classList.toggle('hidden', view !== 'loading');
  els.unpaired.classList.toggle('hidden', view !== 'unpaired');
  els.paired.classList.toggle('hidden', view !== 'paired');
}

function setNotice(el, kind, html) {
  if (!html) { el.className = 'notice hidden'; el.innerHTML = ''; return; }
  el.className = `notice ${kind}`;
  el.innerHTML = html;
}

function render(s) {
  status = s;
  els.version.textContent = `v${s.version || ''}`;
  if (!s.paired) {
    show('unpaired');
    els.appHost.textContent = host(s.appUrl);
    els.pairOrigin.classList.toggle('hidden', !!s.originGranted);
    els.pairOriginHost.textContent = host(s.appUrl);
    els.btnPair.disabled = !s.originGranted;
    if (s.lastSyncStatus === 'unpaired' && s.lastSyncError) setNotice(els.pairError, 'warn', s.lastSyncError);
    return;
  }
  show('paired');
  els.linkOpen.href = `${s.appUrl}/import`;
  els.deviceName.textContent = s.deviceName || '';
  els.statLast.textContent = fmtAgo(s.lastSyncAt);
  els.statNew.textContent = s.lastSyncAt ? fmtNum(s.lastSyncNew || 0) : '—';
  els.statTotal.textContent = fmtNum(s.total);

  // "N new since yesterday" — everything the Companion picked up in the last 24 hours
  const since = Number(s.newSince24h) || 0;
  els.newSince.textContent = since > 0
    ? `${fmtNum(since)} new since yesterday`
    : (s.lastSyncAt ? 'Nothing new since yesterday' : '');

  // status line
  let cls = 'status';
  let text = 'Ready';
  if (s.running) { cls += ' busy'; text = s.progressText || 'Syncing…'; }
  else if (s.walk && s.lastSyncStatus === 'partial') { cls += ' busy'; text = `${s.walk.full ? 'First sync' : 'Sync'} in progress · ${fmtNum(s.walk.newItems || 0)} new so far — continues in a minute`; }
  else if (s.lastSyncStatus === 'ok') { cls += ' ok'; text = s.lastSyncNew > 0 ? `Synced · ${fmtNum(s.lastSyncNew)} new` : 'Up to date'; }
  else if (s.lastSyncStatus === 'login_required') { cls += ' warn'; text = 'Instagram login needed'; }
  else if (s.lastSyncStatus === 'quota') { cls += ' warn'; text = 'Daily sync limit reached'; }
  else if (s.lastSyncStatus === 'error') { cls += ' err'; text = 'Last sync failed'; }
  else if (!s.lastSyncAt) { text = 'Paired · first sync starting'; }
  els.status.className = cls;
  els.statusText.textContent = text;

  // notice
  if (s.running) setNotice(els.notice, '', '');
  else if (s.lastSyncStatus === 'login_required') setNotice(els.notice, 'warn', `You are signed out of Instagram in this browser. <a href="https://www.instagram.com/" target="_blank" rel="noopener">Log in on instagram.com</a>, then Sync now.`);
  else if (s.lastSyncStatus === 'quota') {
    const q = s.harvestQuota;
    const when = q && q.resetsAt ? ` Resets ${fmtAgo(q.resetsAt * 1000).replace(' ago', '')}` : '';
    setNotice(els.notice, 'warn', `Your plan allows ${q && q.limit != null ? q.limit : 'a limited number of'} syncs per day; the rest continues tomorrow. <a href="${s.appUrl}/billing" target="_blank" rel="noopener">See plan</a>.${when}`);
  } else if (s.lastSyncStatus === 'error') setNotice(els.notice, 'err', escapeHtml(s.lastSyncError || 'Something went wrong. Try again in a minute.'));
  else setNotice(els.notice, '', '');

  // sync button
  els.btnSync.disabled = !!s.running;
  els.syncLabel.innerHTML = s.running ? '<span class="spin"></span> Syncing…' : 'Sync now';

  // server-side toggle
  const unavailable = s.serverHarvestAvailable === false && !s.serverHarvest;
  els.toggle.checked = !!s.serverHarvest;
  els.toggle.disabled = !!s.running || unavailable;
  els.toggleWrap.classList.toggle('disabled', unavailable);
  if (unavailable) setNotice(els.serverNotice, '', '');
  else if (s.serverHarvest && s.serverHarvestStatus === 'invalid') setNotice(els.serverNotice, 'warn', 'Instagram signed out the background session. Turn the switch off and on again while logged in to instagram.com to reconnect.');
  else if (s.serverHarvest) setNotice(els.serverNotice, 'ok', 'On — Resurfly checks your saves every 12 h even when Chrome is closed.');
  else setNotice(els.serverNotice, '', '');
  if (unavailable) setNotice(els.serverNotice, 'warn', 'Not available on this server (SERVER_HARVEST_ENABLED is off). Syncing from this browser keeps working.');
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function refresh() {
  try {
    const s = await send({ type: 'getStatus' });
    render(s);
    if (s.running && !pollTimer) pollTimer = setInterval(refresh, 1000);
    if (!s.running && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  } catch (e) {
    els.loading.classList.remove('busy'); els.loading.classList.add('err');
    els.loading.querySelector('span:last-child').textContent = 'Could not reach the extension background. Reload the extension.';
  }
}

/* ---------------- actions ---------------- */
els.btnPair.addEventListener('click', async () => {
  const code = els.code.value.trim().toUpperCase();
  if (!/^RSF-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) { setNotice(els.pairError, 'err', 'That does not look like a pairing code (RSF-XXXX-XXXX).'); els.code.focus(); return; }
  els.btnPair.disabled = true; els.btnPair.innerHTML = '<span class="spin"></span>';
  setNotice(els.pairError, '', '');
  const r = await send({ type: 'pair', code });
  els.btnPair.disabled = false; els.btnPair.textContent = 'Connect';
  if (!r || !r.ok) {
    const msg = (r && r.error) || 'Pairing failed.';
    setNotice(els.pairError, 'err', /expired|invalid|not found|unknown/i.test(msg) ? 'That code is invalid or expired — get a new one in Resurfly → Import → Companion.' : escapeHtml(msg));
    return;
  }
  els.code.value = '';
  await refresh();
});
els.code.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.btnPair.click(); });
els.code.addEventListener('input', () => {
  // auto-format: RSF-XXXX-XXXX
  let v = els.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (v.startsWith('RSF')) v = v.slice(3);
  v = v.slice(0, 8);
  els.code.value = v.length ? 'RSF-' + v.slice(0, 4) + (v.length > 4 ? '-' + v.slice(4) : '') : '';
});

els.btnGrantOrigin.addEventListener('click', async () => {
  if (!status) return;
  const origins = [originPattern(status.appUrl)].filter(Boolean);
  try {
    const ok = await chrome.permissions.request({ origins });
    if (!ok) setNotice(els.pairError, 'warn', 'Access was not granted. The extension cannot reach your Resurfly without it.');
  } catch (e) {
    setNotice(els.pairError, 'err', escapeHtml(e && e.message ? e.message : String(e)));
  }
  await refresh();
});

els.btnSync.addEventListener('click', async () => {
  els.btnSync.disabled = true; els.syncLabel.innerHTML = '<span class="spin"></span> Syncing…';
  send({ type: 'syncNow' }).catch(() => {});
  setTimeout(refresh, 300);
});

els.toggle.addEventListener('change', async () => {
  const enable = els.toggle.checked;
  els.toggle.disabled = true;
  try {
    if (enable) {
      // permission request must run in the popup (user gesture)
      const ok = await chrome.permissions.request({ permissions: ['cookies'] });
      if (!ok) { els.toggle.checked = false; setNotice(els.serverNotice, 'warn', 'The cookies permission is needed to read your Instagram session. Nothing was sent.'); return; }
    }
    const r = await send({ type: 'setServerHarvest', enabled: enable });
    if (!r || !r.ok) {
      els.toggle.checked = !enable;
      setNotice(els.serverNotice, r && r.code === 'login_required' ? 'warn' : 'err', escapeHtml((r && r.error) || 'Could not update the setting.'));
      return;
    }
    if (!enable) {
      // we no longer need the cookies permission — give it back
      try { await chrome.permissions.remove({ permissions: ['cookies'] }); } catch (e) { /* ignore */ }
    }
  } finally {
    els.toggle.disabled = false;
    await refresh();
  }
});

const openOptions = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
els.btnOptions.addEventListener('click', openOptions);
els.linkOptions.addEventListener('click', openOptions);
els.linkChangeUrl.addEventListener('click', openOptions);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && typeof msg.type === 'string' && msg.type.startsWith('sync:')) refresh();
});

show('loading');
refresh();
