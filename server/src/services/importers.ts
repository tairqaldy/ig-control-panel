import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { db, now, j } from '../db.js';
import type { HarvestFile, HarvestItem, MediaType, MediaUrls } from '../types.js';

export interface ImportResult {
  importId: number;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  ids: string[];
  notes?: string;
}

const SHORTCODE_RE = /instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/i;

export function shortcodeFromUrl(url: string): string | null {
  const m = url.match(SHORTCODE_RE);
  return m ? m[1] : null;
}

export function canonicalUrl(shortcode: string, productType?: string | null): string {
  const isReel = productType === 'clips' || productType === 'igtv';
  return `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${shortcode}/`;
}

function mediaTypeOf(h: HarvestItem): MediaType {
  const mt = typeof h.media_type === 'string' ? Number(h.media_type) : h.media_type;
  if (h.carousel && h.carousel.length) return 'carousel';
  if (mt === 8) return 'carousel';
  if (mt === 2 || h.video?.url) return 'video';
  if (mt === 1 || h.thumb?.url) return 'image';
  return 'unknown';
}

function mediaUrlsOf(h: HarvestItem): MediaUrls {
  const m: MediaUrls = { thumb: h.thumb?.url || null, video: h.video?.url || null };
  if (h.carousel && h.carousel.length) {
    m.carousel = h.carousel.map((c) => ({ type: c.video?.url || c.media_type === 2 ? 'video' : 'image', thumb: c.thumb?.url || null, video: c.video?.url || null }));
    if (!m.thumb) m.thumb = m.carousel.find((c) => c.thumb)?.thumb || null;
  }
  return m;
}

function idFor(h: HarvestItem): string | null {
  const code = h.code || (h.url ? shortcodeFromUrl(h.url) : null);
  if (code) return code;
  if (h.url) return 'u_' + crypto.createHash('sha1').update(h.url).digest('hex').slice(0, 16);
  if (h.pk) return 'pk_' + String(h.pk);
  return null;
}

/**
 * Upsert normalized items. Existing items get their volatile fields refreshed (media urls, counts, collections),
 * but their pipeline outputs (analysis, transcript, thumbs) are preserved.
 */
export function upsertItems(items: HarvestItem[], source: 'harvest' | 'export' | 'manual', filename?: string, opts: { rankOffset?: number } = {}): ImportResult {
  const d = db();
  const t = now();
  const ids: string[] = [];
  let created = 0, updated = 0, skipped = 0;

  const getStmt = d.prepare('SELECT id, media_status, analysis_status, saved_at, saved_rank FROM items WHERE id = ?');
  const insertStmt = d.prepare(`INSERT INTO items (
      id, ig_pk, shortcode, url, source, media_type, product_type, author_username, author_name, author_pk, author_verified, author_pic_url,
      caption, alt_text, location, music_title, music_artist, like_count, comment_count, play_count, duration, taken_at, saved_at, saved_rank,
      collections, media_urls, media_urls_fetched_at, raw, media_status, analysis_status, queue_state, created_at, updated_at
    ) VALUES (
      @id, @ig_pk, @shortcode, @url, @source, @media_type, @product_type, @author_username, @author_name, @author_pk, @author_verified, @author_pic_url,
      @caption, @alt_text, @location, @music_title, @music_artist, @like_count, @comment_count, @play_count, @duration, @taken_at, @saved_at, @saved_rank,
      @collections, @media_urls, @media_urls_fetched_at, @raw, 'pending', 'pending', 'idle', @created_at, @updated_at
    )`);
  const updateStmt = d.prepare(`UPDATE items SET
      ig_pk = COALESCE(@ig_pk, ig_pk), shortcode = COALESCE(@shortcode, shortcode), url = @url,
      media_type = CASE WHEN @media_type = 'unknown' THEN media_type ELSE @media_type END,
      product_type = COALESCE(@product_type, product_type),
      author_username = COALESCE(@author_username, author_username), author_name = COALESCE(@author_name, author_name),
      author_pk = COALESCE(@author_pk, author_pk), author_verified = COALESCE(@author_verified, author_verified), author_pic_url = COALESCE(@author_pic_url, author_pic_url),
      caption = COALESCE(@caption, caption), alt_text = COALESCE(@alt_text, alt_text), location = COALESCE(@location, location),
      music_title = COALESCE(@music_title, music_title), music_artist = COALESCE(@music_artist, music_artist),
      like_count = COALESCE(@like_count, like_count), comment_count = COALESCE(@comment_count, comment_count), play_count = COALESCE(@play_count, play_count),
      duration = COALESCE(@duration, duration), taken_at = COALESCE(@taken_at, taken_at), saved_at = COALESCE(@saved_at, saved_at),
      saved_rank = COALESCE(@saved_rank, saved_rank),
      collections = COALESCE(@collections, collections),
      media_urls = CASE WHEN @media_urls IS NOT NULL THEN @media_urls ELSE media_urls END,
      media_urls_fetched_at = CASE WHEN @media_urls IS NOT NULL THEN @media_urls_fetched_at ELSE media_urls_fetched_at END,
      raw = COALESCE(@raw, raw),
      media_status = CASE WHEN @media_urls IS NOT NULL AND media_status IN ('failed','expired','pending') THEN 'pending' ELSE media_status END,
      updated_at = @updated_at
    WHERE id = @id`);

  const tx = d.transaction(() => {
    let rank = opts.rankOffset ?? 0;
    for (const h of items) {
      const id = idFor(h);
      if (!id) { skipped++; continue; }
      const code = h.code || (h.url ? shortcodeFromUrl(h.url) : null);
      const mtype = mediaTypeOf(h);
      const murls = mediaUrlsOf(h);
      const hasMedia = !!(murls.thumb || murls.video || (murls.carousel && murls.carousel.length));
      const loc = typeof h.location === 'string' ? h.location : h.location?.name || null;
      const music = h.music?.title ? h.music.title : null;
      const artist = h.music?.artist || null;
      const musicTitle = music || h.original_audio || null;
      const row = {
        id,
        ig_pk: h.pk ? String(h.pk) : null,
        shortcode: code,
        url: h.url || (code ? canonicalUrl(code, h.product_type) : ''),
        source,
        media_type: mtype,
        product_type: h.product_type || null,
        author_username: h.user?.username || null,
        author_name: h.user?.full_name || null,
        author_pk: h.user?.pk ? String(h.user.pk) : null,
        author_verified: h.user?.is_verified ? 1 : (h.user ? 0 : null),
        author_pic_url: h.user?.profile_pic_url || null,
        caption: h.caption ?? null,
        alt_text: h.alt_text ?? null,
        location: loc,
        music_title: musicTitle,
        music_artist: artist,
        like_count: h.like_count ?? null,
        comment_count: h.comment_count ?? null,
        play_count: h.play_count ?? h.view_count ?? null,
        duration: h.video_duration ?? null,
        taken_at: h.taken_at ?? null,
        saved_at: h.saved_at ?? null,
        saved_rank: source === 'harvest' ? rank : null,
        collections: h.collections && h.collections.length ? JSON.stringify(h.collections) : null,
        media_urls: hasMedia ? JSON.stringify(murls) : null,
        media_urls_fetched_at: hasMedia ? t : null,
        raw: JSON.stringify({ usertags: h.usertags || [], coauthors: h.coauthors || [], is_paid_partnership: !!h.is_paid_partnership, has_audio: h.has_audio ?? null }),
        created_at: t,
        updated_at: t,
      };
      const existing = getStmt.get(id) as any;
      if (existing) {
        updateStmt.run(row);
        updated++;
      } else {
        insertStmt.run(row);
        created++;
      }
      ids.push(id);
      rank++;
    }
  });
  tx();

  const info = d
    .prepare('INSERT INTO imports (source, filename, total, created, updated, skipped, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(source, filename || null, items.length, created, updated, skipped, t);
  return { importId: Number(info.lastInsertRowid), total: items.length, created, updated, skipped, ids };
}

/** Parse a Resurface harvester JSON file (or a raw array of items). */
export function parseHarvestJson(text: string): { file: HarvestFile; items: HarvestItem[] } {
  const data = JSON.parse(text);
  if (Array.isArray(data)) return { file: { format: 'resurface-harvest', version: 1, items: data }, items: data };
  if (data && Array.isArray(data.items)) return { file: data as HarvestFile, items: data.items };
  throw new Error('Unrecognized JSON: expected {items:[...]} from the Resurface harvester');
}

/* ------------------------------------------------------------------ */
/* Instagram "Download your information" export                         */
/* ------------------------------------------------------------------ */

interface DyiSaved { title?: string; string_map_data?: Record<string, { href?: string; value?: string; timestamp?: number }>; string_list_data?: Array<{ href?: string; value?: string; timestamp?: number }> }

/**
 * Parses an Instagram DYI zip (JSON format). Looks for saved_posts.json / saved_collections.json,
 * tolerating both older ("saved/") and newer ("your_instagram_activity/saved/") layouts. Also reads liked_posts.json when `includeLiked`.
 */
export function parseInstagramExportZip(zipBuf: Buffer, opts: { includeLiked?: boolean } = {}): { items: HarvestItem[]; notes: string[] } {
  const zip = new AdmZip(zipBuf);
  const entries = zip.getEntries();
  const notes: string[] = [];
  const items = new Map<string, HarvestItem>();

  const readJson = (name: string): any | null => {
    const e = entries.find((x) => x.entryName.toLowerCase().endsWith(name));
    if (!e) return null;
    try { return JSON.parse(e.getData().toString('utf8')); } catch { return null; }
  };

  const addFromList = (list: DyiSaved[] | undefined, collectionIn?: string, source = 'saved') => {
    let collection = collectionIn;
    if (!Array.isArray(list)) return 0;
    let n = 0;
    for (const s of list) {
      const smd = s.string_map_data || {};
      const savedOn = smd['Saved on'] || Object.values(smd)[0];
      const sld = s.string_list_data?.[0];
      const href = savedOn?.href || sld?.href;
      const ts = savedOn?.timestamp || sld?.timestamp;
      if (!href) continue;
      const code = shortcodeFromUrl(href);
      const key = code || href;
      const existing = items.get(key);
      const username = s.title && !/^\s*$/.test(s.title) ? fixMojibake(s.title) : undefined;
      if (collection) collection = fixMojibake(collection);
      if (existing) {
        if (collection) existing.collections = Array.from(new Set([...(existing.collections || []), collection]));
        if (!existing.saved_at && ts) existing.saved_at = ts;
      } else {
        items.set(key, {
          code: code || undefined,
          url: code ? undefined : href,
          user: username ? { username } : undefined,
          saved_at: ts || null,
          collections: collection ? [collection] : (source === 'liked' ? ['Liked'] : undefined),
        });
        n++;
      }
    }
    return n;
  };

  const savedPosts = readJson('saved_posts.json');
  if (savedPosts) {
    const list: DyiSaved[] = savedPosts.saved_saved_media || savedPosts.saved_posts || savedPosts;
    const n = addFromList(list);
    notes.push(`saved_posts.json: ${n} posts`);
  } else notes.push('saved_posts.json not found');

  const savedCollections = readJson('saved_collections.json');
  if (savedCollections) {
    // Structure: { saved_saved_collections: [ { title: "Collection name", string_map_data: {...} }, ... ] }
    const list: any[] = savedCollections.saved_saved_collections || [];
    let currentCollection: string | undefined;
    let n = 0;
    for (const s of list) {
      const smd = s.string_map_data || {};
      if (smd['Name'] && smd['Name'].value) { currentCollection = smd['Name'].value; continue; }
      n += addFromList([s], currentCollection);
    }
    notes.push(`saved_collections.json: ${n} entries`);
  }

  if (opts.includeLiked) {
    const liked = readJson('liked_posts.json');
    if (liked) {
      const list: DyiSaved[] = liked.likes_media_likes || liked;
      const n = addFromList(list, undefined, 'liked');
      notes.push(`liked_posts.json: ${n} posts`);
    }
  }

  // Sort newest saved first
  const arr = Array.from(items.values()).sort((a, b) => (b.saved_at || 0) - (a.saved_at || 0));
  return { items: arr, notes };
}

/** Manual URL list → items. */
export function itemsFromUrls(urls: string[]): HarvestItem[] {
  const out: HarvestItem[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    const u = raw.trim();
    if (!u) continue;
    const code = shortcodeFromUrl(u);
    const key = code || u;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ code: code || undefined, url: code ? undefined : u, saved_at: now(), product_type: /\/reels?\//.test(u) ? 'clips' : undefined });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Best-effort enrichment for URL-only items (no login): embed endpoint  */
/* ------------------------------------------------------------------ */

// NOTE: the embed page only server-renders for NON-browser user agents (browser UAs get an empty JS shell).
const EMBED_UA = 'curl/8.4.0';

export interface EmbedInfo { caption?: string; thumb?: string; video_url?: string; username?: string; video?: boolean; taken_at?: number; like_count?: number; product_type?: string }

const decodeEntities = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

/** Best-effort, login-free enrichment of a post from its public embed page. */
export async function enrichFromEmbed(shortcode: string): Promise<EmbedInfo | null> {
  const url = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url, { headers: { 'user-agent': EMBED_UA, accept: 'text/html' }, signal: ctrl.signal });
    if (!res.ok) return null;
    const html = await res.text();
    const out: EmbedInfo = {};
    // 1) contextJSON blob (reels/videos usually): {"shortcode_media":{...}}
    const ctx = html.match(/"contextJSON":"((?:\\.|[^"\\])*)"/);
    if (ctx) {
      try {
        const json = JSON.parse(JSON.parse(`"${ctx[1]}"`));
        const sm = json?.shortcode_media || json?.gql_data?.shortcode_media;
        if (sm) {
          out.video_url = sm.video_url || undefined;
          out.thumb = sm.display_url || sm.thumbnail_src || undefined;
          out.username = sm.owner?.username || undefined;
          out.video = !!sm.is_video;
          out.taken_at = sm.taken_at_timestamp || undefined;
          out.like_count = sm.edge_media_preview_like?.count ?? sm.edge_liked_by?.count ?? undefined;
          out.product_type = sm.product_type || undefined;
          const capNode = sm.edge_media_to_caption?.edges?.[0]?.node?.text;
          if (capNode) out.caption = capNode;
        }
      } catch { /* fall through to HTML parsing */ }
    }
    // 2) HTML fallbacks
    if (!out.thumb) {
      const img = html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/) || html.match(/<img[^>]+src="(https:\/\/[^"]*(?:cdninstagram|fbcdn)[^"]+)"/);
      if (img) out.thumb = decodeEntities(img[1]);
    }
    if (!out.username) {
      const user = html.match(/class="UsernameText">([^<]+)</) || html.match(/"owner":\{"username":"([^"]+)"/);
      if (user) out.username = user[1];
    }
    if (!out.caption) {
      const cap = html.match(/<div class="Caption">([\s\S]*?)<\/div>\s*<div class="CaptionComments"/) || html.match(/<div class="Caption">([\s\S]*?)<\/div>/);
      if (cap) {
        out.caption = decodeEntities(cap[1].replace(/<a class="CaptionUsername"[^>]*>[^<]*<\/a>/g, '').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')).trim();
      }
    }
    if (out.video === undefined) out.video = /"is_video":true|EmbedIsVideo|class="EmbeddedMediaVideo"/.test(html);
    if (!out.thumb && !out.caption && !out.username && !out.video_url) return null;
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Instagram's JSON export encodes non-ASCII as latin-1-escaped UTF-8 ("mojibake"). Fix it. */
export function fixMojibake(s: string | undefined | null): string | undefined {
  if (!s) return s ?? undefined;
  // if there are chars in 0x80-0xFF and none above 0xFF, it's very likely mojibake
  if (/[\u0080-\u00ff]/.test(s) && !/[\u0100-\uffff]/.test(s)) {
    try {
      const fixed = Buffer.from(s, 'latin1').toString('utf8');
      if (!fixed.includes('\uFFFD')) return fixed;
    } catch {}
  }
  return s;
}

export function itemCollections(collections: string | null): string[] {
  return j<string[]>(collections, []);
}
