/**
 * Instagram analytics (spec §3): cached account insights, media + per-media insights, derived "what works" stats,
 * and a bundled sample payload for the not-connected state.
 *
 * Storage: ig_snapshots (profile counters per refresh), ig_insights_daily (time-series: reach, follower_count per day),
 * ig_media (+ insights_json), meta `ig_analytics_totals` (total_value metrics per 7/30/90-day window),
 * meta `ig_analytics_refreshed_at`.
 *
 * Rate-limit friendly: sequential requests, ≤ 120 per refresh, at most one refresh per 6 h per tenant unless forced.
 */
import { db, getMeta, j, now, setMeta } from '../db.js';
import { fetchProfile, igCredentials, igGet, instagramConfigured, getAccountRow, noteAccountError } from './instagram.js';
import demo from './ig-analytics-demo.json' with { type: 'json' };

export const REFRESH_INTERVAL_S = 6 * 3600;
export const FORCE_INTERVAL_S = 3600;
export const MAX_REQUESTS = 120;
export type Range = 7 | 30 | 90;

const SERIES_METRICS = ['reach', 'follower_count'];
const TOTAL_METRICS = ['profile_views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares', 'saves', 'replies', 'website_clicks'];
const MEDIA_METRICS = ['reach', 'saved', 'shares', 'likes', 'comments', 'total_interactions'];
const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count';
const KNOWN_METRICS = new Set([...SERIES_METRICS, ...TOTAL_METRICS, ...MEDIA_METRICS, 'views', 'impressions', 'plays', 'total_value']);

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */
export interface MediaStat {
  id: string;
  caption: string;
  type: string;            // IMAGE | VIDEO | CAROUSEL_ALBUM
  productType: string;     // FEED | REELS | STORY | AD
  thumb: string | null;
  permalink: string | null;
  timestamp: number;       // epoch seconds
  likes: number;
  comments: number;
  reach: number | null;
  saved: number | null;
  shares: number | null;
  views: number | null;
  engagementRate: number | null; // % of reach
}
export interface Totals { profileViews: number | null; accountsEngaged: number | null; interactions: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; replies: number | null; websiteClicks: number | null; newFollowers: number | null }
export interface Derived {
  bestHours: Array<{ hour: number; score: number; posts: number }>;
  bestDays: Array<{ weekday: number; label: string; score: number; posts: number }>;
  contentMix: { reels: number; carousels: number; images: number };
  topBySaves: string[];
  topByReach: string[];
  avgEngagementRate: number | null;
  postingCadencePerWeek: number;
  hashtags: Array<{ tag: string; uses: number; avgReach: number | null }>;
  tzOffsetMinutes: number;
}
export interface AnalyticsPayload {
  connected: boolean;
  configured: boolean;
  demo: boolean;
  refreshing: boolean;
  refreshedAt: number | null;
  range: Range;
  account: { username: string | null; name: string | null; profilePictureUrl: string | null; followers: number | null; follows: number | null; media: number | null };
  series: { days: string[]; followers: Array<number | null>; newFollowers: Array<number | null>; reach: Array<number | null> };
  totals: Totals;
  media: MediaStat[];
  derived: Derived;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */
const dayOf = (epochS: number) => new Date(epochS * 1000).toISOString().slice(0, 10);
const startOfUtcDay = (epochS: number) => Math.floor(epochS / 86400) * 86400;
function lastDays(n: number, endS = now()): string[] {
  const end = startOfUtcDay(endS);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayOf(end - i * 86400));
  return out;
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const sumOrNull = (arr: Array<number | null>): number | null => { let s = 0, any = false; for (const v of arr) if (v !== null) { s += v; any = true; } return any ? s : null; };

/** Metric names mentioned in a Graph error message (e.g. "The following metrics (views, plays) are not available…"). */
function metricsInError(msg: string, candidates: string[]): string[] {
  const lower = msg.toLowerCase();
  const found = candidates.filter((m) => new RegExp(`(^|[^a-z_])${m}([^a-z_]|$)`).test(lower));
  // ignore metric names that appear only because the whole request is echoed back (heuristic: keep if the message
  // has parentheses/brackets naming a subset)
  return found.length && found.length < candidates.length ? found : [];
}

/* ------------------------------------------------------------------ */
/* Refresh                                                              */
/* ------------------------------------------------------------------ */
interface Budget { used: number; max: number; errors: string[] }
const canSpend = (b: Budget, n = 1) => b.used + n <= b.max;

/**
 * Request insights for `metrics`, tolerating per-metric errors: on failure drop the metrics the error names and retry;
 * if the error doesn't name any, bisect. Returns the raw `data[]` items merged by metric name.
 */
async function tolerantInsights(path: string, metrics: string[], params: Record<string, string>, token: string, b: Budget, depth = 0): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  if (!metrics.length || !canSpend(b)) return out;
  b.used++;
  const r = await igGet<{ data: any[] }>(path, { ...params, metric: metrics.join(',') }, token);
  if (r.ok && Array.isArray(r.data?.data)) {
    for (const item of r.data.data) if (item?.name) out.set(String(item.name), item);
    return out;
  }
  const msg = r.error || 'unknown error';
  b.errors.push(`${path} [${metrics.join(',')}]: ${msg}`);
  if (r.status === 0 || r.errorCode === 190 || r.errorCode === 4 || r.errorCode === 17 || r.errorCode === 32 || depth > 3) return out; // network / auth / rate-limit: don't dig
  const bad = metricsInError(msg, metrics);
  if (bad.length) {
    const rest = metrics.filter((m) => !bad.includes(m));
    for (const [k, v] of await tolerantInsights(path, rest, params, token, b, depth + 1)) out.set(k, v);
    return out;
  }
  if (metrics.length === 1) return out;
  const half = Math.ceil(metrics.length / 2);
  for (const [k, v] of await tolerantInsights(path, metrics.slice(0, half), params, token, b, depth + 1)) out.set(k, v);
  for (const [k, v] of await tolerantInsights(path, metrics.slice(half), params, token, b, depth + 1)) out.set(k, v);
  return out;
}

/** Day of an insights `end_time` ("2026-08-16T07:00:00+0000" = the end of Aug 15 in the account's timezone). */
function dayOfEndTime(endTime: string): string | null {
  const t = Date.parse(endTime);
  if (!Number.isFinite(t)) return null;
  return new Date(t - 12 * 3600_000).toISOString().slice(0, 10);
}

const inflight = new Set<number>();
export function isRefreshing(tid: number): boolean { return inflight.has(tid); }
export function lastRefreshedAt(tid: number): number | null { const v = getMeta(tid, 'ig_analytics_refreshed_at'); return v ? Number(v) : null; }

export interface RefreshResult { ok: boolean; skipped?: 'fresh' | 'in_progress' | 'not_connected'; error?: string; requests: number; errors: string[]; refreshedAt: number | null; media?: number }

/**
 * Pull everything for a tenant. `force` bypasses the 6 h freshness window (the route enforces the 1 h / owner rule).
 * Never throws; per-metric errors are collected in `errors` and never fail the whole refresh.
 */
export async function refreshAnalytics(tid: number, opts: { force?: boolean } = {}): Promise<RefreshResult> {
  const creds = igCredentials(tid);
  if (!creds) return { ok: false, skipped: 'not_connected', error: 'Instagram is not connected', requests: 0, errors: [], refreshedAt: lastRefreshedAt(tid) };
  const last = lastRefreshedAt(tid);
  if (!opts.force && last && now() - last < REFRESH_INTERVAL_S) return { ok: true, skipped: 'fresh', requests: 0, errors: [], refreshedAt: last };
  if (inflight.has(tid)) return { ok: true, skipped: 'in_progress', requests: 0, errors: [], refreshedAt: last };
  inflight.add(tid);
  const b: Budget = { used: 0, max: MAX_REQUESTS, errors: [] };
  const d = db();
  const t = now();
  const token = creds.accessToken, uid = creds.igUserId;
  try {
    // 1. profile counters → snapshot
    b.used++;
    const profile = await fetchProfile(tid);
    if (profile) d.prepare('INSERT INTO ig_snapshots (tenant_id, taken_at, followers_count, follows_count, media_count) VALUES (?, ?, ?, ?, ?)').run(tid, t, num(profile.followers_count), num(profile.follows_count), num(profile.media_count));
    else b.errors.push('profile: could not load /me');

    // 2. time series (last 30 days): reach + follower_count per day
    const since30 = t - 30 * 86400;
    const series = await tolerantInsights(`${uid}/insights`, SERIES_METRICS, { period: 'day', since: String(since30), until: String(t) }, token, b);
    const upsertDaily = d.prepare('INSERT INTO ig_insights_daily (tenant_id, day, metric, value) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, day, metric) DO UPDATE SET value = excluded.value');
    d.transaction(() => {
      for (const [name, item] of series) {
        for (const v of item?.values || []) {
          const day = v?.end_time ? dayOfEndTime(String(v.end_time)) : null;
          const val = num(v?.value);
          if (day && val !== null) upsertDaily.run(tid, day, name, val);
        }
      }
    })();

    // 3. totals per window (7, 30, 90 = 3 × 30-day windows; the API caps a request at 30 days)
    const totals: Record<string, Record<string, number | null>> = {};
    const windows: Array<[string, Array<[number, number]>]> = [
      ['7', [[t - 7 * 86400, t]]],
      ['30', [[t - 30 * 86400, t]]],
      ['90', [[t - 30 * 86400, t], [t - 60 * 86400, t - 30 * 86400], [t - 90 * 86400, t - 60 * 86400]]],
    ];
    for (const [key, spans] of windows) {
      const acc: Record<string, number | null> = {};
      for (const m of TOTAL_METRICS) acc[m] = null;
      for (const [since, until] of spans) {
        const got = await tolerantInsights(`${uid}/insights`, TOTAL_METRICS, { period: 'day', metric_type: 'total_value', since: String(since), until: String(until) }, token, b);
        for (const [name, item] of got) {
          const v = num(item?.total_value?.value ?? item?.values?.[0]?.value);
          if (v !== null) acc[name] = (acc[name] ?? 0) + v;
        }
      }
      totals[key] = acc;
    }
    setMeta(tid, 'ig_analytics_totals', JSON.stringify({ at: t, ...totals }));

    // 4. media (2 pages × 50)
    const mediaRows: any[] = [];
    let url: string | null = `${uid}/media`;
    let absolute = false;
    for (let page = 0; page < 2 && url && canSpend(b); page++) {
      b.used++;
      const r: { ok: boolean; error: string | null; data: { data: any[]; paging?: { next?: string } } | null } = await igGet(url, absolute ? {} : { fields: MEDIA_FIELDS, limit: '50' }, token, absolute);
      if (!r.ok || !Array.isArray(r.data?.data)) { b.errors.push(`media: ${r.error}`); break; }
      mediaRows.push(...r.data!.data);
      url = r.data!.paging?.next || null;
      absolute = true;
    }
    const upsertMedia = d.prepare(`INSERT INTO ig_media (tenant_id, id, caption, media_type, media_product_type, media_url, thumbnail_url, permalink, timestamp, like_count, comments_count, insights_json, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(tenant_id, id) DO UPDATE SET caption = excluded.caption, media_type = excluded.media_type, media_product_type = excluded.media_product_type, media_url = excluded.media_url,
        thumbnail_url = excluded.thumbnail_url, permalink = excluded.permalink, timestamp = excluded.timestamp, like_count = excluded.like_count, comments_count = excluded.comments_count, fetched_at = excluded.fetched_at`);
    d.transaction(() => {
      for (const m of mediaRows) {
        if (!m?.id) continue;
        const ts = m.timestamp ? Math.floor(Date.parse(m.timestamp) / 1000) : null;
        upsertMedia.run(tid, String(m.id), m.caption ?? null, m.media_type ?? null, m.media_product_type ?? null, m.media_url ?? null, m.thumbnail_url ?? null, m.permalink ?? null, Number.isFinite(ts as number) ? ts : null, num(m.like_count), num(m.comments_count), t);
      }
    })();

    // 5. per-media insights, newest first; skip media whose insights are < 24 h old and that are older than 7 days (they've settled)
    const existing = new Map<string, { insights_json: string | null; fetched: number | null }>();
    for (const r of d.prepare('SELECT id, insights_json, json_extract(insights_json, \'$._at\') AS fetched FROM ig_media WHERE tenant_id = ?').all(tid) as any[]) existing.set(String(r.id), { insights_json: r.insights_json, fetched: num(r.fetched) });
    const setInsights = d.prepare('UPDATE ig_media SET insights_json = ? WHERE tenant_id = ? AND id = ?');
    const sorted = [...mediaRows].filter((m) => m?.id).sort((a, b2) => String(b2.timestamp || '').localeCompare(String(a.timestamp || '')));
    let mediaDone = 0;
    for (const m of sorted) {
      if (!canSpend(b, 1)) break;
      const id = String(m.id);
      const ts = m.timestamp ? Math.floor(Date.parse(m.timestamp) / 1000) : 0;
      const prev = existing.get(id);
      if (prev?.insights_json && prev.fetched && t - prev.fetched < 86400 && ts && t - ts > 7 * 86400) continue;
      const isVideo = m.media_type === 'VIDEO' || m.media_product_type === 'REELS';
      const metrics = isVideo ? [...MEDIA_METRICS, 'views'] : MEDIA_METRICS;
      const before = b.used;
      const got = await tolerantInsights(`${id}/insights`, metrics, {}, token, b);
      // cap the per-media digging so one weird post can't burn the budget
      if (b.used - before > 3) b.errors.push(`${id}: needed ${b.used - before} requests`);
      const ins: Record<string, number | null> = {};
      for (const [name, item] of got) ins[name] = num(item?.values?.[0]?.value ?? item?.total_value?.value);
      setInsights.run(JSON.stringify({ ...ins, _at: t }), tid, id);
      mediaDone++;
    }

    setMeta(tid, 'ig_analytics_refreshed_at', String(t));
    if (b.errors.length) console.warn(`[ig-analytics] tenant ${tid}: ${b.errors.length} non-fatal errors during refresh (${b.used} requests)`);
    if (b.errors.some((e) => /code 190\b/.test(e))) noteAccountError(tid, 'Instagram rejected the access token — reconnect Instagram.');
    return { ok: true, requests: b.used, errors: b.errors.slice(0, 40), refreshedAt: t, media: mediaDone };
  } catch (e: any) {
    b.errors.push(`fatal: ${e?.message || e}`);
    return { ok: false, error: String(e?.message || e), requests: b.used, errors: b.errors.slice(0, 40), refreshedAt: lastRefreshedAt(tid) };
  } finally {
    inflight.delete(tid);
  }
}

/** Fire-and-forget refresh when the cache is stale (used by GET /analytics). */
export function refreshInBackground(tid: number, opts: { force?: boolean } = {}): boolean {
  if (inflight.has(tid)) return true;
  const last = lastRefreshedAt(tid);
  if (!opts.force && last && now() - last < REFRESH_INTERVAL_S) return false;
  void refreshAnalytics(tid, opts).catch(() => {});
  return true;
}

/* ------------------------------------------------------------------ */
/* Payload                                                              */
/* ------------------------------------------------------------------ */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function engagement(m: MediaStat): number { return (m.likes || 0) + (m.comments || 0) + (m.saved || 0) + (m.shares || 0); }

/** Derived stats over a set of media (hours/weekdays shifted by `tzOffsetMinutes`, minutes east of UTC). */
export function deriveStats(media: MediaStat[], rangeDays: number, tzOffsetMinutes = 0): Derived {
  const hourAgg = Array.from({ length: 24 }, () => ({ sum: 0, n: 0 }));
  const dayAgg = Array.from({ length: 7 }, () => ({ sum: 0, n: 0 }));
  const mix = { reels: 0, carousels: 0, images: 0 };
  const tags = new Map<string, { uses: number; reachSum: number; reachN: number }>();
  let erSum = 0, erN = 0;
  for (const m of media) {
    const local = new Date((m.timestamp + tzOffsetMinutes * 60) * 1000);
    const e = engagement(m);
    const score = m.reach ? e / m.reach : e; // engagement rate when reach is known, raw engagement otherwise
    const h = hourAgg[local.getUTCHours()]; h.sum += score; h.n++;
    const w = dayAgg[local.getUTCDay()]; w.sum += score; w.n++;
    if (m.productType === 'REELS' || m.type === 'VIDEO') mix.reels++; else if (m.type === 'CAROUSEL_ALBUM') mix.carousels++; else mix.images++;
    if (m.engagementRate !== null) { erSum += m.engagementRate; erN++; }
    for (const tag of new Set((m.caption.match(/#([\p{L}\p{N}_]+)/gu) || []).map((s) => s.slice(1).toLowerCase()))) {
      const cur = tags.get(tag) || { uses: 0, reachSum: 0, reachN: 0 };
      cur.uses++;
      if (m.reach !== null) { cur.reachSum += m.reach; cur.reachN++; }
      tags.set(tag, cur);
    }
  }
  const norm = (agg: Array<{ sum: number; n: number }>) => {
    const raw = agg.map((a) => (a.n ? (a.sum / a.n) * (a.n / (a.n + 1)) : 0)); // mean, shrunk toward 0 for tiny samples
    const max = Math.max(0, ...raw);
    return raw.map((v) => (max > 0 ? Math.round((v / max) * 1000) / 1000 : 0));
  };
  const hourScores = norm(hourAgg), dayScores = norm(dayAgg);
  const withReach = media.filter((m) => m.reach !== null);
  const withSaves = media.filter((m) => m.saved !== null);
  return {
    bestHours: hourScores.map((score, hour) => ({ hour, score, posts: hourAgg[hour].n })),
    bestDays: dayScores.map((score, weekday) => ({ weekday, label: WEEKDAYS[weekday], score, posts: dayAgg[weekday].n })),
    contentMix: mix,
    topBySaves: [...withSaves].sort((a, b) => (b.saved || 0) - (a.saved || 0)).slice(0, 6).map((m) => m.id),
    topByReach: [...withReach].sort((a, b) => (b.reach || 0) - (a.reach || 0)).slice(0, 6).map((m) => m.id),
    avgEngagementRate: erN ? Math.round((erSum / erN) * 100) / 100 : null,
    postingCadencePerWeek: rangeDays > 0 ? Math.round((media.length / (rangeDays / 7)) * 10) / 10 : 0,
    hashtags: [...tags.entries()].map(([tag, v]) => ({ tag, uses: v.uses, avgReach: v.reachN ? Math.round(v.reachSum / v.reachN) : null })).sort((a, b) => b.uses - a.uses || (b.avgReach || 0) - (a.avgReach || 0)).slice(0, 25),
    tzOffsetMinutes,
  };
}

function toMediaStat(x: { id: string; caption: string | null; type: string | null; productType: string | null; thumb: string | null; permalink: string | null; timestamp: number; likes: number | null; comments: number | null; reach: number | null; saved: number | null; shares: number | null; views: number | null }): MediaStat {
  const likes = x.likes ?? 0, comments = x.comments ?? 0;
  const eng = likes + comments + (x.saved ?? 0) + (x.shares ?? 0);
  return {
    id: x.id,
    caption: (x.caption || '').slice(0, 140),
    type: x.type || 'IMAGE',
    productType: x.productType || 'FEED',
    thumb: x.thumb,
    permalink: x.permalink,
    timestamp: x.timestamp,
    likes, comments,
    reach: x.reach, saved: x.saved, shares: x.shares, views: x.views,
    engagementRate: x.reach ? Math.round((eng / x.reach) * 10000) / 100 : null,
  };
}

/** Pick the media for a range: everything posted inside the window; if that is fewer than 4, the latest 12 overall. */
function pickForRange<T extends { timestamp: number }>(all: T[], sinceS: number): T[] {
  const inRange = all.filter((m) => m.timestamp >= sinceS);
  return inRange.length >= 4 ? inRange : all.slice(0, 12);
}

const parseRange = (r: unknown): Range => (Number(r) === 7 ? 7 : Number(r) === 90 ? 90 : 30);

/** The bundled sample (dates are relative: index 0 = oldest of 90 days; media.daysAgo). */
export function demoPayload(range: Range | number = 30, tzOffsetMinutes = 0): AnalyticsPayload {
  const R = parseRange(range);
  const t = now();
  const days = lastDays(R);
  const n = demo.days;
  const slice = <T,>(arr: T[]) => arr.slice(n - R);
  const daily = demo.daily as Record<string, number[]>;
  const sum = (key: string) => slice(daily[key] || []).reduce((a, b) => a + b, 0);
  const media: MediaStat[] = demo.media.map((m) => {
    const dayStart = startOfUtcDay(t) - m.daysAgo * 86400;
    return toMediaStat({ id: m.id, caption: m.caption, type: m.type, productType: m.productType, thumb: m.thumb, permalink: m.permalink, timestamp: dayStart + m.hour * 3600 - tzOffsetMinutes * 60, likes: m.likes, comments: m.comments, reach: m.reach, saved: m.saved, shares: m.shares, views: m.views });
  }).sort((a, b) => b.timestamp - a.timestamp);
  const picked = pickForRange(media, startOfUtcDay(t) - (R - 1) * 86400);
  return {
    connected: false,
    configured: instagramConfigured(),
    demo: true,
    refreshing: false,
    refreshedAt: null,
    range: R,
    account: { username: demo.account.username, name: demo.account.name, profilePictureUrl: demo.account.profilePictureUrl, followers: demo.account.followers, follows: demo.account.follows, media: demo.account.media },
    series: { days, followers: slice(demo.series.followers), newFollowers: slice(demo.series.newFollowers), reach: slice(demo.series.reach) },
    totals: { profileViews: sum('profileViews'), accountsEngaged: sum('accountsEngaged'), interactions: sum('interactions'), likes: sum('likes'), comments: sum('comments'), shares: sum('shares'), saves: sum('saves'), replies: sum('replies'), websiteClicks: sum('websiteClicks'), newFollowers: slice(demo.series.newFollowers).reduce((a, b) => a + b, 0) },
    media: picked,
    derived: deriveStats(picked, R, tzOffsetMinutes),
  };
}

/** GET /api/instagram/analytics payload. Falls back to the sample when the tenant has no Instagram credentials. */
export function analyticsPayload(tid: number, range: Range | number = 30, tzOffsetMinutes = 0): AnalyticsPayload {
  const creds = igCredentials(tid);
  if (!creds) return demoPayload(range, tzOffsetMinutes);
  const R = parseRange(range);
  const d = db();
  const t = now();
  const days = lastDays(R);
  const sinceS = startOfUtcDay(t) - (R - 1) * 86400;

  // account
  const row = getAccountRow(tid);
  const snap = d.prepare('SELECT * FROM ig_snapshots WHERE tenant_id = ? ORDER BY taken_at DESC LIMIT 1').get(tid) as { taken_at: number; followers_count: number | null; follows_count: number | null; media_count: number | null } | undefined;
  const account = {
    username: row?.username ?? getMeta(tid, 'ig_username'),
    name: row?.name ?? null,
    profilePictureUrl: row?.profile_picture_url ?? null,
    followers: row?.followers_count ?? snap?.followers_count ?? null,
    follows: row?.follows_count ?? snap?.follows_count ?? null,
    media: row?.media_count ?? snap?.media_count ?? null,
  };

  // series
  const daily = d.prepare('SELECT day, metric, value FROM ig_insights_daily WHERE tenant_id = ? AND day >= ? AND metric IN (\'reach\', \'follower_count\')').all(tid, days[0]) as Array<{ day: string; metric: string; value: number | null }>;
  const reachBy = new Map<string, number>(), newBy = new Map<string, number>();
  for (const r of daily) if (r.value !== null) (r.metric === 'reach' ? reachBy : newBy).set(r.day, r.value);
  const reach = days.map((day) => reachBy.get(day) ?? null);
  const newFollowers = days.map((day) => newBy.get(day) ?? null);
  // followers per day: latest snapshot per day where we have one; otherwise reconstruct backwards from the current count minus daily new followers
  const snapsByDay = new Map<string, number>();
  for (const s of d.prepare('SELECT taken_at, followers_count FROM ig_snapshots WHERE tenant_id = ? AND taken_at >= ? ORDER BY taken_at ASC').all(tid, sinceS) as Array<{ taken_at: number; followers_count: number | null }>) if (s.followers_count !== null) snapsByDay.set(dayOf(s.taken_at), s.followers_count);
  const followers: Array<number | null> = new Array(R).fill(null);
  let anchor: number | null = account.followers;
  for (let i = R - 1; i >= 0; i--) {
    const s = snapsByDay.get(days[i]);
    if (s !== undefined) anchor = s;
    followers[i] = anchor;
    if (anchor !== null) { const nf = newBy.get(days[i]); if (nf !== undefined) anchor = anchor - nf; }
  }

  // totals
  const totalsAll = j<Record<string, Record<string, number | null>>>(getMeta(tid, 'ig_analytics_totals'), {});
  const tw = totalsAll[String(R)] || {};
  const g = (k: string) => (typeof tw[k] === 'number' ? tw[k] : null);
  const totals: Totals = { profileViews: g('profile_views'), accountsEngaged: g('accounts_engaged'), interactions: g('total_interactions'), likes: g('likes'), comments: g('comments'), shares: g('shares'), saves: g('saves'), replies: g('replies'), websiteClicks: g('website_clicks'), newFollowers: sumOrNull(newFollowers) };

  // media
  const rows = d.prepare('SELECT * FROM ig_media WHERE tenant_id = ? ORDER BY timestamp DESC LIMIT 100').all(tid) as any[];
  const all: MediaStat[] = rows.map((r) => {
    const ins = j<Record<string, number | null>>(r.insights_json, {});
    return toMediaStat({ id: String(r.id), caption: r.caption, type: r.media_type, productType: r.media_product_type, thumb: r.thumbnail_url || r.media_url || null, permalink: r.permalink, timestamp: Number(r.timestamp) || 0, likes: num(r.like_count), comments: num(r.comments_count), reach: num(ins.reach), saved: num(ins.saved), shares: num(ins.shares), views: num(ins.views ?? ins.plays ?? ins.impressions) });
  });
  const picked = pickForRange(all, sinceS);

  return {
    connected: true,
    configured: instagramConfigured(),
    demo: false,
    refreshing: inflight.has(tid),
    refreshedAt: lastRefreshedAt(tid),
    range: R,
    account,
    series: { days, followers, newFollowers, reach },
    totals,
    media: picked,
    derived: deriveStats(picked, R, tzOffsetMinutes),
  };
}
