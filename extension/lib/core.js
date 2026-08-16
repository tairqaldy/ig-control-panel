/*
 * Resurfly harvester core — the SOURCE OF TRUTH for everything that touches Instagram's saved-posts endpoints:
 * endpoint paths, request headers and the normalization of a raw feed item into the HarvestItem shape the server imports.
 *
 * Pure ESM, no dependencies, no DOM, no Node APIs — usable from
 *   - the server (server/src/services/companion.ts imports it for the background harvester),
 *   - the browser extension (extension/lib/core.js is a plain copy: `cp harvester/core.js extension/lib/core.js`),
 *   - the console harvester (harvester/harvester.js inlines the block between the @core-begin/@core-end markers;
 *     regenerate with `node harvester/build.mjs`, verify with `node harvester/build.mjs --check`).
 *
 * Keep it dependency-free and side-effect-free. Do not add `import` statements.
 */

/* @core-begin */
export const IG_ORIGIN = 'https://www.instagram.com';
export const IG_APP_ID = '936619743392459';
export const HARVEST_FORMAT = 'resurface-harvest';
export const HARVEST_VERSION = 1;

/** Saved feed (all saved posts, newest first, ~20 per page). */
export const SAVED_FEED_PATH = '/api/v1/feed/saved/posts/';
/** Collections list (paginated). */
export const COLLECTIONS_LIST_PATH = '/api/v1/collections/list/';
/** Posts of one collection. */
export const collectionFeedPath = (collectionId) => `/api/v1/feed/collection/${encodeURIComponent(String(collectionId))}/posts/`;
/** Basic user info (username for the account block). */
export const userInfoPath = (userId) => `/api/v1/users/${encodeURIComponent(String(userId))}/info/`;

const withMaxId = (path, maxId) => path + (maxId ? `?max_id=${encodeURIComponent(maxId)}` : '');
/** URL of one saved-feed page. `origin` = '' for same-origin (browser) or IG_ORIGIN for the server. */
export const savedFeedUrl = (maxId = '', origin = '') => origin + withMaxId(SAVED_FEED_PATH, maxId);
export const collectionFeedUrl = (collectionId, maxId = '', origin = '') => origin + withMaxId(collectionFeedPath(collectionId), maxId);
export const collectionsListUrl = (maxId = '', origin = '') => origin + COLLECTIONS_LIST_PATH + '?collection_types=' + encodeURIComponent('["ALL_MEDIA_AUTO_COLLECTION","MEDIA"]') + '&include_public_only=0&get_cover_media_lists=false&max_id=' + encodeURIComponent(maxId || '');
export const userInfoUrl = (userId, origin = '') => origin + userInfoPath(userId);

/**
 * Request headers for Instagram's web API.
 * Browser: call with no arguments (cookies travel via credentials:'include'; forbidden headers are simply not set).
 * Server: pass the stored session — `sessionid`, `csrftoken`, `dsUserId`, `ua`, and `username` (for the referer).
 */
export function buildHeaders(opts = {}) {
  const h = { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest', accept: '*/*' };
  if (opts.csrftoken) h['x-csrftoken'] = opts.csrftoken;
  if (opts.sessionid) {
    h.cookie = `sessionid=${opts.sessionid}; csrftoken=${opts.csrftoken || ''}; ds_user_id=${opts.dsUserId || ''}`;
    h['sec-fetch-site'] = 'same-origin';
    h['sec-fetch-mode'] = 'cors';
    h['sec-fetch-dest'] = 'empty';
    h['accept-language'] = 'en-US,en;q=0.9';
  }
  if (opts.ua) h['user-agent'] = opts.ua;
  if (opts.referer) h.referer = opts.referer;
  else if (opts.username) h.referer = `${IG_ORIGIN}/${opts.username}/saved/`;
  else if (opts.sessionid) h.referer = `${IG_ORIGIN}/`;
  return h;
}

/** Media objects of a feed page (the feed wraps them as {media:{...}}; collections return them bare). Items without a code are dropped. */
export function pageItems(data) {
  const list = (data && Array.isArray(data.items)) ? data.items : [];
  const out = [];
  for (const it of list) {
    const m = it && (it.media || it);
    if (m && m.code) out.push(m);
  }
  return out;
}

/** Pagination of a feed page: `more` only when Instagram says so AND handed us a cursor AND the page was not empty. */
export function pageCursor(data) {
  const list = (data && Array.isArray(data.items)) ? data.items : [];
  const more = !!(data && data.more_available && data.next_max_id && list.length > 0);
  return { more, nextMaxId: more ? String(data.next_max_id) : '' };
}

/** One page of the collections list → { total (all saved media), collections:[{id,name,count}], nextMaxId }. */
export function parseCollectionsPage(cl) {
  const items = (cl && Array.isArray(cl.items)) ? cl.items : [];
  const auto = items.find((c) => c.collection_type === 'ALL_MEDIA_AUTO_COLLECTION');
  const total = (cl && cl.all_saved_media_count) || (auto && auto.collection_media_count) || null;
  const collections = items.filter((c) => c.collection_type === 'MEDIA').map((c) => ({ id: String(c.collection_id), name: c.collection_name, count: c.collection_media_count || 0 }));
  const nextMaxId = cl && cl.more_available && cl.next_max_id ? String(cl.next_max_id) : '';
  return { total, collections, nextMaxId };
}

/** Prefer the largest image <= 1080 wide, else the largest available. */
export function pickImg(iv2) {
  const c = iv2 && iv2.candidates;
  if (!c || !c.length) return null;
  const sorted = c.slice().sort((a, b) => (b.width || 0) - (a.width || 0));
  const good = sorted.find((x) => (x.width || 0) <= 1080) || sorted[0];
  return good ? { url: good.url, width: good.width, height: good.height } : null;
}
/** Smallest video that is still >= 480px wide (cheap to fetch, fine for frames/transcript), else the smallest. */
export function pickVideo(vv) {
  if (!vv || !vv.length) return null;
  const sorted = vv.slice().sort((a, b) => (a.width || 0) - (b.width || 0));
  const good = sorted.find((x) => (x.width || 0) >= 480) || sorted[sorted.length - 1];
  return good ? { url: good.url, width: good.width, height: good.height } : null;
}
export function musicOf(m) {
  const cm = m.clips_metadata || {};
  const mi = cm.music_info && cm.music_info.music_asset_info;
  if (mi && (mi.title || mi.display_artist)) return { title: mi.title || '', artist: mi.display_artist || '' };
  return null;
}
export function originalAudio(m) {
  const cm = m.clips_metadata || {};
  const o = cm.original_sound_info;
  return o ? (o.original_audio_title || 'Original audio') : null;
}

/**
 * Raw Instagram media (or a {media} wrapper) → HarvestItem (server/src/types.ts). Throws on a shape it cannot read.
 * ctx.collections: names of the collections this item belongs to (optional).
 */
export function normalizeItem(node, ctx) {
  const m = node && node.media ? node.media : node;
  if (!m || typeof m !== 'object') throw new Error('not a media object');
  const collections = ctx && Array.isArray(ctx.collections) ? ctx.collections : null;
  const code = m.code;
  const isClip = m.product_type === 'clips' || m.product_type === 'igtv';
  const car = Array.isArray(m.carousel_media) ? m.carousel_media.map((c) => ({ pk: String(c.pk || c.id || ''), media_type: c.media_type, thumb: pickImg(c.image_versions2), video: pickVideo(c.video_versions), alt_text: c.accessibility_caption || null })) : null;
  return {
    pk: String(m.pk || m.id || ''),
    code,
    url: code ? `${IG_ORIGIN}/${isClip ? 'reel' : 'p'}/${code}/` : undefined,
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

/** The file/body shape the server's harvest importers accept. */
export function buildHarvestPayload({ account = null, collections = [], items = [] } = {}) {
  return { format: HARVEST_FORMAT, version: HARVEST_VERSION, exported_at: Math.floor(Date.now() / 1000), account, collections, items };
}

/** Random pause between pages (ms): 1.5–2.5 s by default — polite to Instagram, fast enough for a few hundred saves. */
export function pageDelayMs(min = 1500, spread = 1000) {
  return min + Math.random() * spread;
}

/** Heuristic: did Instagram answer with a login page / HTML instead of JSON? (session expired, logged out) */
export function looksLikeLoginPage(status, contentType, text) {
  if (status === 401 || status === 403) return true;
  if (contentType && /text\/html/i.test(contentType)) return true;
  if (typeof text === 'string' && /^\s*</.test(text)) return true;
  return false;
}
/** Same check for a fetch Response (+ its body text): also catches the redirect to /accounts/login/. */
export function looksLikeLoggedOut(res, text) {
  if (!res) return false;
  const url = typeof res.url === 'string' ? res.url : '';
  if (/\/accounts\/login\/?/.test(url) || (res.redirected && /\/accounts\//.test(url))) return true;
  const ct = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : null;
  return looksLikeLoginPage(res.status, ct, text);
}

/**
 * One saved-feed page → { items: HarvestItem[] (already normalized, unreadable ones skipped), moreAvailable, nextMaxId, rawCount }.
 * Convenience for the extension/server loops.
 */
export function parseFeedPage(data, ctx) {
  const raw = pageItems(data);
  const items = [];
  for (const m of raw) {
    try { items.push(normalizeItem(m, ctx || null)); } catch (e) { /* skip unreadable */ }
  }
  const cur = pageCursor(data);
  return { items, moreAvailable: cur.more, nextMaxId: cur.nextMaxId, rawCount: raw.length };
}
/* @core-end */
