/* Resurfly Companion — options page: app URL for self-hosters (with chrome.permissions.request), pairing, unpair. */

import { originPattern, DEFAULT_APP_URL } from './lib/store.js';
import { normalizeAppUrl } from './lib/api.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const host = (url) => { try { return new URL(url).host; } catch (e) { return url || ''; } };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const setNotice = (el, kind, html) => { if (!html) { el.className = 'notice hidden'; el.innerHTML = ''; return; } el.className = `notice ${kind}`; el.innerHTML = html; };
const fmtAgo = (ms) => {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  if (d < 45 * 1000) return 'just now';
  const m = Math.round(d / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
};

const welcome = new URLSearchParams(location.search).get('welcome') === '1';
$('welcome').classList.toggle('hidden', !welcome);
$('title').classList.toggle('hidden', welcome);

let status = null;

async function refresh() {
  status = await send({ type: 'getStatus' });
  const s = status;
  $('version').textContent = `v${s.version || ''}`;
  $('pair-unpaired').classList.toggle('hidden', !!s.paired);
  $('pair-paired').classList.toggle('hidden', !s.paired);
  if (s.paired) {
    $('device-name').textContent = s.deviceName || 'this browser';
    $('paired-host').textContent = host(s.appUrl);
    $('paired-since').textContent = s.pairedAt ? `(since ${new Date(s.pairedAt).toLocaleDateString()})` : '';
    $('last-sync').textContent = fmtAgo(s.lastSyncAt);
    $('total').textContent = typeof s.total === 'number' ? s.total.toLocaleString() : '—';
  } else {
    $('pair-origin').classList.toggle('hidden', !!s.originGranted);
    $('pair-origin-host').textContent = host(s.appUrl);
    $('btn-pair').disabled = !s.originGranted;
  }
  if (document.activeElement !== $('app-url')) $('app-url').value = s.appUrl || DEFAULT_APP_URL;
  $('app-url').disabled = !!s.paired;
  $('btn-save-url').disabled = !!s.paired;
  $('url-hint').textContent = s.paired
    ? 'Remove the pairing to change the URL.'
    : (s.originGranted ? `Access to ${host(s.appUrl)} is granted.` : `Access to ${host(s.appUrl)} is not granted yet — press Save to allow it.`);
}

$('btn-save-url').addEventListener('click', async () => {
  const base = normalizeAppUrl($('app-url').value);
  if (!base) { setNotice($('url-notice'), 'err', 'Enter a full URL, e.g. https://resurfly.example.com'); return; }
  const origin = originPattern(base);
  let granted = await chrome.permissions.contains({ origins: [origin] });
  if (!granted) {
    try { granted = await chrome.permissions.request({ origins: [origin] }); } catch (e) { setNotice($('url-notice'), 'err', escapeHtml(e && e.message ? e.message : String(e))); return; }
  }
  if (!granted) { setNotice($('url-notice'), 'warn', `Chrome did not grant access to ${host(base)}. Without it the extension cannot reach your Resurfly.`); return; }
  const r = await send({ type: 'setAppUrl', url: base });
  if (!r || !r.ok) { setNotice($('url-notice'), 'err', escapeHtml((r && r.error) || 'Could not save.')); return; }
  setNotice($('url-notice'), 'ok', `Saved. The extension will talk to ${host(base)}.`);
  await refresh();
});

$('btn-pair').addEventListener('click', async () => {
  const code = $('code').value.trim().toUpperCase();
  if (!/^RSF-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) { setNotice($('pair-error'), 'err', 'That does not look like a pairing code (RSF-XXXX-XXXX).'); return; }
  $('btn-pair').disabled = true;
  setNotice($('pair-error'), '', '');
  const r = await send({ type: 'pair', code });
  $('btn-pair').disabled = false;
  if (!r || !r.ok) {
    const msg = (r && r.error) || 'Pairing failed.';
    setNotice($('pair-error'), 'err', /expired|invalid|not found|unknown/i.test(msg) ? 'That code is invalid or expired — get a new one in Resurfly → Import → Companion.' : escapeHtml(msg));
    return;
  }
  $('code').value = '';
  await refresh();
});
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-pair').click(); });
$('code').addEventListener('input', () => {
  let v = $('code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (v.startsWith('RSF')) v = v.slice(3);
  v = v.slice(0, 8);
  $('code').value = v.length ? 'RSF-' + v.slice(0, 4) + (v.length > 4 ? '-' + v.slice(4) : '') : '';
});

$('btn-unpair').addEventListener('click', async () => {
  if (!confirm('Remove the pairing? Syncing from this browser stops. Your library in Resurfly is untouched.')) return;
  await send({ type: 'unpair' });
  await refresh();
});

chrome.runtime.onMessage.addListener((msg) => { if (msg && typeof msg.type === 'string' && msg.type.startsWith('sync:')) refresh(); });
refresh();
