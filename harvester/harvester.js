/*
 * Resurface harvester - exports YOUR Instagram saved posts as a JSON file.
 *
 * How it works: you run this in your own browser while logged into instagram.com. It calls the same
 * internal endpoints the Instagram web app uses, paginates through your saved posts (and collections),
 * normalizes them, and downloads a JSON file you then upload to your Resurface dashboard.
 *
 * It never sends anything anywhere except to instagram.com itself. Read it - it's short.
 *
 * Usage:
 *   1) Open https://www.instagram.com/ (logged in)
 *   2) Open DevTools console (F12 -> Console). Chrome may ask you to type "allow pasting" first.
 *   3) Paste this whole file, press Enter. A small panel appears bottom-right. Click "Start".
 *   4) When it finishes, click "Download JSON" and upload the file at __RESURFACE_URL__ -> Import.
 *
 * Or drag the "Harvest saves" bookmarklet from the Import page to your bookmarks bar and click it on instagram.com.
 */
(function () {
  'use strict';
  const APP_ID = '936619743392459';
  const VERSION = 1;
  const RESURFACE_URL = '__RESURFACE_URL__';
  const PANEL_ID = 'resurface-harvester';

  if (!/(^|\.)instagram\.com$/.test(location.hostname)) {
    alert('Open https://www.instagram.com/ (logged in) and run the harvester there.');
    return;
  }
  const old = document.getElementById(PANEL_ID);
  if (old) old.remove();

  /* ---------------- tiny UI (CSP-safe: styles via CSSOM only) ---------------- */
  const css = (el, s) => { el.style.cssText = s; return el; };
  const mk = (tag, style, text) => { const e = document.createElement(tag); if (style) css(e, style); if (text != null) e.textContent = text; return e; };
  const font = "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;";
  const panel = mk('div', `position:fixed;right:16px;bottom:16px;z-index:2147483647;width:340px;background:#141412;color:#f2efe8;border:1px solid #2a2926;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.45);padding:14px 16px 12px;${font}font-size:13px;line-height:1.45;`);
  panel.id = PANEL_ID;
  const head = mk('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;');
  const title = mk('div', 'font-weight:600;letter-spacing:.2px;font-size:14px;', 'Resurface - Harvest saves');
  const closeBtn = mk('button', 'background:transparent;border:0;color:#9b978e;font-size:18px;cursor:pointer;line-height:1;padding:2px 4px;', 'x');
  closeBtn.onclick = () => { stopFlag = true; panel.remove(); };
  head.append(title, closeBtn); panel.append(head);
  const status = mk('div', 'color:#c9c4b8;min-height:36px;white-space:pre-wrap;', 'Ready. This reads your saved posts using your own session - nothing leaves instagram.com until you download the file.');
  panel.append(status);
  const bar = mk('div', 'height:6px;background:#2a2926;border-radius:99px;overflow:hidden;margin:10px 0 6px;');
  const fill = mk('div', 'height:100%;width:0%;background:#4fd39a;transition:width .3s;');
  bar.append(fill); panel.append(bar);
  const counts = mk('div', 'display:flex;gap:14px;color:#9b978e;font-variant-numeric:tabular-nums;margin-bottom:10px;');
  const cItems = mk('span', '', '0 saves'); const cPages = mk('span', '', '0 pages'); const cCols = mk('span', '', '');
  counts.append(cItems, cPages, cCols); panel.append(counts);
  const opts = mk('div', 'display:flex;flex-direction:column;gap:6px;margin-bottom:10px;color:#c9c4b8;');
  const mkCheck = (label, checked) => { const l = mk('label', 'display:flex;align-items:center;gap:8px;cursor:pointer;'); const i = document.createElement('input'); i.type = 'checkbox'; i.checked = checked; css(i, 'accent-color:#4fd39a;'); l.append(i, mk('span', '', label)); opts.append(l); return i; };
  const optCollections = mkCheck('Also map my collections (extra requests)', true);
  const limitRow = mk('label', 'display:flex;align-items:center;gap:8px;');
  const limitInput = document.createElement('input'); limitInput.type = 'number'; limitInput.min = '0'; limitInput.placeholder = 'all'; css(limitInput, 'width:80px;background:#1d1c1a;border:1px solid #2a2926;color:#f2efe8;border-radius:8px;padding:4px 8px;font-size:13px;');
  limitRow.append(mk('span', '', 'Max saves (blank = all)'), limitInput); opts.append(limitRow);
  panel.append(opts);
  const btns = mk('div', 'display:flex;gap:8px;');
  const btn = (label, primary) => mk('button', `flex:1;border-radius:10px;padding:8px 10px;font-weight:600;font-size:13px;cursor:pointer;border:1px solid ${primary ? '#4fd39a' : '#3a3935'};background:${primary ? '#4fd39a' : 'transparent'};color:${primary ? '#141412' : '#f2efe8'};`, label);
  const startBtn = btn('Start', true); const stopBtn = btn('Stop & download', false); const dlBtn = btn('Download JSON', false);
  stopBtn.disabled = true; dlBtn.disabled = true; css(stopBtn, stopBtn.style.cssText + 'opacity:.5;'); css(dlBtn, dlBtn.style.cssText + 'opacity:.5;');
  btns.append(startBtn, stopBtn, dlBtn); panel.append(btns);
  const foot = mk('div', 'margin-top:8px;color:#6f6c65;font-size:11px;', 'Keep this tab open while it runs. ~1 request/second to stay polite.');
  panel.append(foot);
  document.body.appendChild(panel);
  const setStatus = (t) => { status.textContent = t; };
  const enable = (b, on) => { b.disabled = !on; b.style.opacity = on ? '1' : '.5'; };

  /* ---------------- fetch helpers ---------------- */
  let stopFlag = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const headers = { 'x-ig-app-id': APP_ID, 'x-requested-with': 'XMLHttpRequest', accept: '*/*' };
  async function api(path, attempt = 0) {
    let res;
    try {
      res = await fetch(path, { headers, credentials: 'include' });
    } catch (netErr) {
      // transient network hiccup (tab throttled, wifi blip, connection reset) - back off and retry
      if (attempt >= 6) throw new Error(`Network error (${netErr && netErr.message ? netErr.message : netErr}). Check your connection and click Start to resume.`);
      const wait = 3000 * Math.pow(2, attempt);
      setStatus(`Network hiccup. Retrying in ${wait / 1000}s... (${items.length} saves so far)`);
      await sleep(wait);
      return api(path, attempt + 1);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 4) throw new Error(`Instagram responded ${res.status} repeatedly. Try again later - click Start to resume.`);
      const wait = 20000 * (attempt + 1);
      setStatus(`Rate limited (HTTP ${res.status}). Waiting ${wait / 1000}s... (${items.length} saves so far)`);
      await sleep(wait);
      return api(path, attempt + 1);
    }
    if (res.status === 401 || res.status === 403) throw new Error(`Not authorized (HTTP ${res.status}). Are you logged in? Try reloading instagram.com.`);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) { throw new Error('Unexpected non-JSON response (are you logged in?)'); }
  }

  /* ---------------- normalization ---------------- */
  const pickImg = (iv2) => {
    const c = iv2 && iv2.candidates;
    if (!c || !c.length) return null;
    // prefer the largest <= 1080 wide, else the largest available
    const sorted = c.slice().sort((a, b) => (b.width || 0) - (a.width || 0));
    const good = sorted.find((x) => (x.width || 0) <= 1080) || sorted[0];
    return good ? { url: good.url, width: good.width, height: good.height } : null;
  };
  const pickVideo = (vv) => {
    if (!vv || !vv.length) return null;
    // smallest that is still >= 480px wide (cheap to fetch, fine for frames/transcript), else the smallest
    const sorted = vv.slice().sort((a, b) => (a.width || 0) - (b.width || 0));
    const good = sorted.find((x) => (x.width || 0) >= 480) || sorted[sorted.length - 1];
    return good ? { url: good.url, width: good.width, height: good.height } : null;
  };
  const musicOf = (m) => {
    const cm = m.clips_metadata || {};
    const mi = cm.music_info && cm.music_info.music_asset_info;
    if (mi && (mi.title || mi.display_artist)) return { title: mi.title || '', artist: mi.display_artist || '' };
    return null;
  };
  const originalAudio = (m) => { const cm = m.clips_metadata || {}; const o = cm.original_sound_info; return o ? (o.original_audio_title || 'Original audio') : null; };
  function normalize(m, collections) {
    const code = m.code;
    const isClip = m.product_type === 'clips' || m.product_type === 'igtv';
    const car = Array.isArray(m.carousel_media) ? m.carousel_media.map((c) => ({ pk: String(c.pk || c.id || ''), media_type: c.media_type, thumb: pickImg(c.image_versions2), video: pickVideo(c.video_versions), alt_text: c.accessibility_caption || null })) : null;
    return {
      pk: String(m.pk || m.id || ''),
      code,
      url: code ? `https://www.instagram.com/${isClip ? 'reel' : 'p'}/${code}/` : undefined,
      taken_at: m.taken_at || null,
      media_type: m.media_type,
      product_type: m.product_type || null,
      caption: (m.caption && m.caption.text) || null,
      alt_text: m.accessibility_caption || null,
      user: m.user ? { pk: String(m.user.pk || m.user.id || ''), username: m.user.username, full_name: m.user.full_name, is_verified: !!m.user.is_verified, profile_pic_url: m.user.profile_pic_url } : null,
      like_count: typeof m.like_count === 'number' ? m.like_count : null,
      comment_count: typeof m.comment_count === 'number' ? m.comment_count : null,
      play_count: typeof m.play_count === 'number' ? m.play_count : (typeof m.ig_play_count === 'number' ? m.ig_play_count : null),
      view_count: typeof m.view_count === 'number' ? m.view_count : null,
      video_duration: typeof m.video_duration === 'number' ? m.video_duration : null,
      location: m.location && m.location.name ? { name: m.location.name } : null,
      music: musicOf(m),
      original_audio: originalAudio(m),
      thumb: pickImg(m.image_versions2) || (car && car.find((c) => c.thumb) ? car.find((c) => c.thumb).thumb : null),
      video: pickVideo(m.video_versions),
      carousel: car,
      collections: collections && collections.length ? collections : undefined,
      usertags: m.usertags && m.usertags.in ? m.usertags.in.map((u) => u.user && u.user.username).filter(Boolean) : undefined,
      coauthors: Array.isArray(m.coauthor_producers) ? m.coauthor_producers.map((u) => u.username).filter(Boolean) : undefined,
      is_paid_partnership: !!m.is_paid_partnership,
      has_audio: typeof m.has_audio === 'boolean' ? m.has_audio : undefined,
    };
  }

  /* ---------------- main ---------------- */
  const items = [];
  const byCode = new Map();
  let pages = 0;
  let collectionsInfo = [];
  let account = null;
  let total = null;
  // pagination cursor kept across runs so "Start" after an error/stop RESUMES instead of restarting
  let maxId = '';
  let feedDone = false;

  async function harvest() {
    stopFlag = false;
    enable(startBtn, false); enable(stopBtn, true); enable(dlBtn, false);
    const limit = Number(limitInput.value) > 0 ? Number(limitInput.value) : Infinity;
    try {
      // account + totals (best effort, only the first time)
      if (!account) {
        try {
          const uid = (document.cookie.match(/ds_user_id=(\d+)/) || [])[1];
          if (uid) { const u = await api(`/api/v1/users/${uid}/info/`); account = { ds_user_id: uid, username: u && u.user && u.user.username }; }
        } catch (e) { /* ignore */ }
      }
      if (total === null) {
        try {
          const cl = await api('/api/v1/collections/list/?collection_types=' + encodeURIComponent('["ALL_MEDIA_AUTO_COLLECTION","MEDIA"]') + '&include_public_only=0&get_cover_media_lists=false&max_id=');
          total = cl.all_saved_media_count || (cl.items && cl.items.find((c) => c.collection_type === 'ALL_MEDIA_AUTO_COLLECTION') || {}).collection_media_count || null;
          collectionsInfo = (cl.items || []).filter((c) => c.collection_type === 'MEDIA').map((c) => ({ id: String(c.collection_id), name: c.collection_name, count: c.collection_media_count || 0 }));
          cCols.textContent = collectionsInfo.length ? `${collectionsInfo.length} collections` : '';
        } catch (e) { /* ignore */ }
      }

      // main saved feed (resumes from the last cursor)
      let more = !feedDone;
      if (items.length && more) setStatus(`Resuming from ${items.length} saves...`);
      while (more && !stopFlag && items.length < limit) {
        const data = await api('/api/v1/feed/saved/posts/' + (maxId ? `?max_id=${encodeURIComponent(maxId)}` : ''));
        pages++;
        const list = data.items || [];
        for (const it of list) {
          const m = it.media || it;
          if (!m || !m.code) continue;
          if (byCode.has(m.code)) continue;
          const n = normalize(m, null);
          byCode.set(m.code, n);
          items.push(n);
          if (items.length >= limit) break;
        }
        more = !!data.more_available && !!data.next_max_id && list.length > 0;
        maxId = data.next_max_id || '';
        if (!more) feedDone = true;
        cItems.textContent = `${items.length} saves`; cPages.textContent = `${pages} pages`;
        const pct = total ? Math.min(100, Math.round((items.length / Math.min(total, limit)) * 100)) : Math.min(95, pages * 2);
        fill.style.width = pct + '%';
        setStatus(`Fetching saved posts... ${items.length}${total ? ` / ${Math.min(total, limit)}` : ''}`);
        window.__resurfaceProgress = { items: items.length, pages, total, cursor: maxId };
        if (more) await sleep(900 + Math.random() * 900);
      }

      // collections membership (only after the main feed completed)
      if (feedDone && optCollections.checked && collectionsInfo.length && !stopFlag) {
        for (const col of collectionsInfo) {
          if (stopFlag) break;
          let cMax = ''; let cMore = true; let guard = 0;
          while (cMore && !stopFlag && guard++ < 400) {
            setStatus(`Mapping collection "${col.name}"...`);
            let data;
            try { data = await api(`/api/v1/feed/collection/${col.id}/posts/` + (cMax ? `?max_id=${encodeURIComponent(cMax)}` : '')); }
            catch (e) { console.warn('[resurface] collection failed', col.name, e); break; }
            pages++;
            for (const it of (data.items || [])) {
              const m = it.media || it; if (!m || !m.code) continue;
              let n = byCode.get(m.code);
              if (!n) { n = normalize(m, null); byCode.set(m.code, n); items.push(n); }
              n.collections = Array.from(new Set([...(n.collections || []), col.name]));
            }
            cMore = !!data.more_available && !!data.next_max_id && (data.items || []).length > 0;
            cMax = data.next_max_id || '';
            cItems.textContent = `${items.length} saves`; cPages.textContent = `${pages} pages`;
            if (cMore) await sleep(900 + Math.random() * 900);
          }
        }
      }
      fill.style.width = '100%';
      setStatus(stopFlag ? `Stopped. ${items.length} saves collected - download the JSON below.` : `Done! ${items.length} saves collected. Download the JSON, then upload it at ${RESURFACE_URL.startsWith('http') ? RESURFACE_URL + '/import' : 'your Resurface dashboard -> Import'}.`);
    } catch (e) {
      console.error('[resurface harvester]', e);
      setStatus(`Error: ${e && e.message ? e.message : e}\n${items.length ? `${items.length} saves collected so far - you can still download them.` : ''}`);
    }
    enable(startBtn, true); enable(stopBtn, false); enable(dlBtn, items.length > 0);
    window.__resurfaceHarvest = buildPayload();
    window.__resurfaceDone = true;
    if (items.length && !stopFlag) download();
  }

  function buildPayload() {
    return { format: 'resurface-harvest', version: VERSION, exported_at: Math.floor(Date.now() / 1000), account, collections: collectionsInfo, items };
  }

  function download() {
    const payload = buildPayload();
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date(); const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    a.href = URL.createObjectURL(blob);
    a.download = `resurface-harvest-${stamp}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    window.__resurfaceHarvest = payload;
    setStatus(`Downloaded ${items.length} saves as ${a.download}. Now upload it at ${RESURFACE_URL.startsWith('http') ? RESURFACE_URL + '/import' : 'your Resurface dashboard -> Import'}.\nNo file? Click "Download JSON" again, or run copy(JSON.stringify(window.__resurfaceHarvest)) in the console and paste into a .json file.`);
  }

  window.__resurfaceStart = harvest;
  startBtn.onclick = harvest;
  stopBtn.onclick = () => { stopFlag = true; setStatus('Stopping after the current page...'); };
  dlBtn.onclick = download;
})();
