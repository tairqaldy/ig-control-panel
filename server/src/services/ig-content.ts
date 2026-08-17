/**
 * Own-content profile (ROUND6-SPEC §4) — a compact, factual picture of what the user actually POSTS, built straight
 * from the cached Instagram tables (`ig_media`, `ig_insights_daily`, `ig_snapshots`). Ask injects it so an answer can
 * connect what someone saves to what they publish.
 *
 * Everything here is measured. Nothing is estimated, and a metric the account never returned stays null so the prompt
 * can say "not available" instead of inventing a number.
 *
 * Public surface (used by services/ask.ts):
 *   ownContentProfile(tid, limit?)            – the profile plus a ready-made prompt block in `.text`
 *   recentPostsText(profile)                  – just the "last N posts" list (for the analytics strategy, whose
 *                                               payload already carries the aggregates)
 *   crossReferenceText(profile, library)      – measured overlap between saved topics and posted captions
 *   isAccountQuestion(question)               – is this question about their own account/posts?
 *   isCrossRefQuestion(question)              – "does what I save match what I post?"
 */
import { db, getMeta, j, now } from '../db.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface OwnPost {
  id: string;
  /** reel | video | carousel | image | story */
  format: string;
  /** YYYY-MM-DD (UTC) */
  date: string;
  /** UTC hour of publication, null when the timestamp is missing */
  hour: number | null;
  /** caption gist, hashtags/links stripped, <= 100 chars */
  gist: string;
  hashtags: string[];
  permalink: string | null;
  likes: number | null;
  comments: number | null;
  reach: number | null;
  saves: number | null;
  shares: number | null;
  views: number | null;
  /** interactions as a % of reach, null when reach is unknown */
  engagementRate: number | null;
}

export interface OwnAverages {
  posts: number;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  engagementRate: number | null;
  postsPerWeek: number | null;
  byFormat: Array<{ format: string; posts: number; avgReach: number | null; avgEngagementRate: number | null }>;
}

export interface OwnSlot { label: string; posts: number; avgEngagementRate: number | null; avgInteractions: number | null }

export interface OwnContentProfile {
  connected: boolean;
  hasPosts: boolean;
  account: { username: string | null; followers: number | null; follows: number | null; mediaCount: number | null };
  /** followers at the start and end of the snapshot window, when snapshots cover it */
  followerTrend: { from: number; to: number; days: number } | null;
  /** total reach over the last 30 days from ig_insights_daily, when present */
  reach30d: number | null;
  newFollowers30d: number | null;
  posts: OwnPost[];
  averages: OwnAverages;
  bestHours: OwnSlot[];
  bestDays: OwnSlot[];
  hashtags: Array<{ tag: string; uses: number; avgReach: number | null }>;
  refreshedAt: number | null;
  /** full prompt block; empty string when there is nothing worth injecting */
  text: string;
}

export interface LibraryTopics {
  tags: Array<{ name: string; n: number }>;
  categories: Array<{ name: string; n: number }>;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;

const avg = (xs: Array<number | null>, digits = 0): number | null => {
  const vals = xs.filter((v): v is number => v !== null);
  if (!vals.length) return null;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const p = 10 ** digits;
  return Math.round(m * p) / p;
};

function tableExists(name: string): boolean {
  try {
    return !!db().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  } catch {
    return false;
  }
}

function formatOf(mediaType: string | null, productType: string | null): string {
  const p = String(productType || '').toUpperCase();
  const t = String(mediaType || '').toUpperCase();
  if (p === 'REELS') return 'reel';
  if (p === 'STORY') return 'story';
  if (t === 'CAROUSEL_ALBUM') return 'carousel';
  if (t === 'VIDEO') return 'video';
  return 'image';
}

/** Caption gist: no links, no hashtags, one line, <= `max` characters. */
export function captionGist(caption: string | null | undefined, max = 100): string {
  const s = String(caption || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

const hashtagsIn = (caption: string | null | undefined): string[] =>
  Array.from(new Set((String(caption || '').match(/#[\p{L}\p{N}_]+/gu) || []).map((h) => h.slice(1).toLowerCase())));

const interactions = (p: OwnPost): number | null => {
  const parts = [p.likes, p.comments, p.saves, p.shares].filter((v): v is number => v !== null);
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
};

/* ------------------------------------------------------------------ */
/* Profile                                                             */
/* ------------------------------------------------------------------ */

const EMPTY: OwnContentProfile = {
  connected: false,
  hasPosts: false,
  account: { username: null, followers: null, follows: null, mediaCount: null },
  followerTrend: null,
  reach30d: null,
  newFollowers30d: null,
  posts: [],
  averages: { posts: 0, reach: null, likes: null, comments: null, saves: null, engagementRate: null, postsPerWeek: null, byFormat: [] },
  bestHours: [],
  bestDays: [],
  hashtags: [],
  refreshedAt: null,
  text: '',
};

/**
 * Build the profile for a tenant. Never throws: a missing Instagram migration, an empty cache or a broken row all end
 * up as `{ connected:false, hasPosts:false, text:'' }`, which every caller treats as "no own-content context".
 */
export function ownContentProfile(tid: number, limit = 12): OwnContentProfile {
  try {
    if (!tableExists('ig_media')) return EMPTY;
    const d = db();
    const account = (() => {
      try {
        const r = d.prepare('SELECT username, followers_count, follows_count, media_count FROM ig_accounts WHERE tenant_id = ?').get(tid) as any;
        if (r) return { username: r.username ?? null, followers: num(r.followers_count), follows: num(r.follows_count), mediaCount: num(r.media_count) };
      } catch { /* table absent */ }
      return { username: getMeta(tid, 'ig_username'), followers: null, follows: null, mediaCount: null };
    })();

    const rows = d.prepare('SELECT * FROM ig_media WHERE tenant_id = ? ORDER BY timestamp DESC LIMIT ?').all(tid, Math.max(1, limit)) as any[];
    const posts: OwnPost[] = rows.map((r) => {
      const ins = j<Record<string, number | null>>(r.insights_json, {});
      const likes = num(r.like_count), comments = num(r.comments_count);
      const reach = num(ins.reach), saves = num(ins.saved), shares = num(ins.shares);
      const ts = Number(r.timestamp) || 0;
      const eng = [likes, comments, saves, shares].filter((v): v is number => v !== null).reduce((a, b) => a + b, 0);
      return {
        id: String(r.id),
        format: formatOf(r.media_type, r.media_product_type),
        date: ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '',
        hour: ts ? new Date(ts * 1000).getUTCHours() : null,
        gist: captionGist(r.caption),
        hashtags: hashtagsIn(r.caption),
        permalink: r.permalink ?? null,
        likes,
        comments,
        reach,
        saves,
        shares,
        views: num(ins.views ?? ins.plays ?? ins.impressions),
        engagementRate: reach ? Math.round((eng / reach) * 10000) / 100 : null,
      };
    });

    const nonStory = posts.filter((p) => p.format !== 'story');
    const hasPosts = nonStory.length > 0;

    // averages over the posts in hand
    const byFormatMap = new Map<string, OwnPost[]>();
    for (const p of nonStory) byFormatMap.set(p.format, [...(byFormatMap.get(p.format) || []), p]);
    const dates = nonStory.map((p) => p.date).filter(Boolean).sort();
    const spanDays = dates.length > 1 ? Math.max(1, (Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) - Date.parse(`${dates[0]}T00:00:00Z`)) / 86400000) : null;
    const averages: OwnAverages = {
      posts: nonStory.length,
      reach: avg(nonStory.map((p) => p.reach)),
      likes: avg(nonStory.map((p) => p.likes)),
      comments: avg(nonStory.map((p) => p.comments)),
      saves: avg(nonStory.map((p) => p.saves)),
      engagementRate: avg(nonStory.map((p) => p.engagementRate), 2),
      postsPerWeek: spanDays ? Math.round((nonStory.length / (spanDays / 7)) * 10) / 10 : null,
      byFormat: [...byFormatMap.entries()]
        .map(([format, ps]) => ({ format, posts: ps.length, avgReach: avg(ps.map((p) => p.reach)), avgEngagementRate: avg(ps.map((p) => p.engagementRate), 2) }))
        .sort((a, b) => b.posts - a.posts),
    };

    const slots = (key: (p: OwnPost) => string | null): OwnSlot[] => {
      const m = new Map<string, OwnPost[]>();
      for (const p of nonStory) {
        const k = key(p);
        if (k === null) continue;
        m.set(k, [...(m.get(k) || []), p]);
      }
      // rank on the mean shrunk toward zero for tiny samples, so a single lucky post cannot outrank a real pattern.
      // The reported averages stay untouched — only the order uses the shrunk score.
      const shrink = (v: number | null, n: number) => (v === null ? -1 : v * (n / (n + 1)));
      return [...m.entries()]
        .map(([label, ps]) => ({ label, posts: ps.length, avgEngagementRate: avg(ps.map((p) => p.engagementRate), 2), avgInteractions: avg(ps.map(interactions)) }))
        .sort((a, b) => shrink(b.avgEngagementRate, b.posts) - shrink(a.avgEngagementRate, a.posts) || shrink(b.avgInteractions, b.posts) - shrink(a.avgInteractions, a.posts) || b.posts - a.posts)
        .slice(0, 3);
    };
    const bestHours = slots((p) => (p.hour === null ? null : `${String(p.hour).padStart(2, '0')}:00 UTC`));
    const bestDays = slots((p) => (p.date ? WEEKDAYS[new Date(`${p.date}T12:00:00Z`).getUTCDay()] : null));

    const tagAgg = new Map<string, { uses: number; reachSum: number; reachN: number }>();
    for (const p of nonStory) {
      for (const tag of p.hashtags) {
        const cur = tagAgg.get(tag) || { uses: 0, reachSum: 0, reachN: 0 };
        cur.uses++;
        if (p.reach !== null) { cur.reachSum += p.reach; cur.reachN++; }
        tagAgg.set(tag, cur);
      }
    }
    const hashtags = [...tagAgg.entries()]
      .map(([tag, v]) => ({ tag, uses: v.uses, avgReach: v.reachN ? Math.round(v.reachSum / v.reachN) : null }))
      .sort((a, b) => b.uses - a.uses || (b.avgReach ?? 0) - (a.avgReach ?? 0))
      .slice(0, 10);

    // 30-day context from the daily insights + profile snapshots
    let reach30d: number | null = null;
    let newFollowers30d: number | null = null;
    if (tableExists('ig_insights_daily')) {
      const since = new Date((now() - 30 * 86400) * 1000).toISOString().slice(0, 10);
      const daily = d.prepare('SELECT metric, SUM(value) AS total FROM ig_insights_daily WHERE tenant_id = ? AND day >= ? GROUP BY metric').all(tid, since) as Array<{ metric: string; total: number | null }>;
      for (const r of daily) {
        const total = num(r.total);
        if (total === null) continue;
        if (r.metric === 'reach') reach30d = Math.round(total);
        if (r.metric === 'follower_count') newFollowers30d = Math.round(total);
      }
    }
    let followerTrend: OwnContentProfile['followerTrend'] = null;
    if (tableExists('ig_snapshots')) {
      const snaps = d.prepare('SELECT taken_at, followers_count FROM ig_snapshots WHERE tenant_id = ? AND taken_at >= ? AND followers_count IS NOT NULL ORDER BY taken_at ASC').all(tid, now() - 30 * 86400) as Array<{ taken_at: number; followers_count: number }>;
      if (snaps.length > 1) {
        const first = snaps[0], last = snaps[snaps.length - 1];
        followerTrend = { from: first.followers_count, to: last.followers_count, days: Math.max(1, Math.round((last.taken_at - first.taken_at) / 86400)) };
      }
    }

    const refreshedRaw = getMeta(tid, 'ig_analytics_refreshed_at');
    const refreshedAt = refreshedRaw ? Number(refreshedRaw) || null : null;
    const connected = (() => {
      try {
        if (d.prepare('SELECT 1 FROM ig_accounts WHERE tenant_id = ?').get(tid)) return true;
      } catch { /* table absent */ }
      return hasPosts;
    })();

    const profile: OwnContentProfile = { connected, hasPosts, account, followerTrend, reach30d, newFollowers30d, posts: nonStory, averages, bestHours, bestDays, hashtags, refreshedAt, text: '' };
    profile.text = buildText(profile);
    return profile;
  } catch {
    return EMPTY;
  }
}

/* ------------------------------------------------------------------ */
/* Prompt blocks                                                       */
/* ------------------------------------------------------------------ */

const int = (v: number | null): string => (v === null ? '?' : String(Math.round(v)));
const erText = (v: number | null): string => (v === null ? 'engagement rate n/a' : `engagement rate ${v}%`);

function postLine(p: OwnPost): string {
  const metrics = [
    p.reach === null ? null : `reach ${int(p.reach)}`,
    p.views === null ? null : `views ${int(p.views)}`,
    p.likes === null ? null : `likes ${int(p.likes)}`,
    p.comments === null ? null : `comments ${int(p.comments)}`,
    p.saves === null ? null : `saves ${int(p.saves)}`,
    p.engagementRate === null ? null : erText(p.engagementRate),
  ].filter(Boolean).join(', ');
  const when = `${p.date || 'date unknown'}${p.hour === null ? '' : `, ${String(p.hour).padStart(2, '0')}:00 UTC`}`;
  return `- post ${p.id} · ${p.format} · ${when} · ${metrics || 'no metrics available'} — "${p.gist || '(no caption)'}"${p.hashtags.length ? ` [#${p.hashtags.slice(0, 5).join(' #')}]` : ''}`;
}

/** Just the recent-posts list — for prompts that already carry the account aggregates (the analytics strategy). */
export function recentPostsText(p: OwnContentProfile): string {
  if (!p.hasPosts) return '';
  return [`The user's last ${p.posts.length} posts, newest first:`, ...p.posts.map(postLine)].join('\n');
}

function buildText(p: OwnContentProfile): string {
  if (!p.hasPosts) return '';
  const L: string[] = [];
  const a = p.account;
  L.push(
    `Account: ${a.username ? `@${a.username}` : 'their connected Instagram account'}${a.followers !== null ? ` — ${a.followers} followers` : ''}${a.mediaCount !== null ? `, ${a.mediaCount} posts published` : ''}.${p.refreshedAt ? ` Numbers last refreshed ${new Date(p.refreshedAt * 1000).toISOString().slice(0, 10)}.` : ''}`,
  );
  L.push(recentPostsText(p));
  const av = p.averages;
  const avgBits = [
    av.reach === null ? null : `reach ${int(av.reach)}`,
    av.likes === null ? null : `likes ${int(av.likes)}`,
    av.comments === null ? null : `comments ${int(av.comments)}`,
    av.saves === null ? null : `saves ${int(av.saves)}`,
    av.engagementRate === null ? null : `engagement rate ${av.engagementRate}%`,
  ].filter(Boolean).join(', ');
  if (avgBits) L.push(`Averages over those ${av.posts} posts: ${avgBits}.${av.postsPerWeek !== null ? ` About ${av.postsPerWeek} posts a week.` : ''}`);
  if (av.byFormat.length) L.push(`By format: ${av.byFormat.map((f) => `${f.format} ${f.posts}${f.avgReach !== null ? ` (avg reach ${int(f.avgReach)}${f.avgEngagementRate !== null ? `, avg ${erText(f.avgEngagementRate)}` : ''})` : ''}`).join(', ')}.`);
  if (p.bestHours.length) L.push(`Best publishing hours in this sample: ${p.bestHours.map((s) => `${s.label} (${s.posts} post${s.posts === 1 ? '' : 's'}${s.avgEngagementRate !== null ? `, avg ${erText(s.avgEngagementRate)}` : ''})`).join(', ')}. These are small samples — a hint, not a rule.`);
  if (p.bestDays.length) L.push(`Best weekdays in this sample: ${p.bestDays.map((s) => `${s.label} (${s.posts} post${s.posts === 1 ? '' : 's'}${s.avgEngagementRate !== null ? `, avg ${erText(s.avgEngagementRate)}` : ''})`).join(', ')}.`);
  if (p.hashtags.length) L.push(`Hashtags they use: ${p.hashtags.map((h) => `#${h.tag} ${h.uses}x${h.avgReach !== null ? ` (avg reach ${h.avgReach})` : ''}`).join(', ')}.`);
  if (p.followerTrend) L.push(`Followers over the last ${p.followerTrend.days} days: ${p.followerTrend.from} → ${p.followerTrend.to} (${p.followerTrend.to - p.followerTrend.from >= 0 ? '+' : ''}${p.followerTrend.to - p.followerTrend.from}).`);
  if (p.reach30d !== null) L.push(`Total reach over the last 30 days: ${p.reach30d}.${p.newFollowers30d !== null ? ` New followers in that window: ${p.newFollowers30d}.` : ''}`);
  return L.join('\n');
}

/* ------------------------------------------------------------------ */
/* Cross-reference (saved vs posted)                                   */
/* ------------------------------------------------------------------ */

const words = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);

/** Does a post's caption/hashtags cover this topic? (all of the topic's words appear, or the joined hashtag matches) */
function postMentions(p: OwnPost, topic: string): boolean {
  const hay = `${p.gist} ${p.hashtags.join(' ')}`.toLowerCase();
  const joined = topic.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (joined.length >= 4 && p.hashtags.some((h) => h.replace(/[^\p{L}\p{N}]+/gu, '') === joined)) return true;
  const ws = words(topic);
  return ws.length > 0 && ws.every((w) => hay.includes(w));
}

/**
 * Measured overlap between the topics the user saves and the captions of their recent posts. Every number here is a
 * count of real rows, so an answer can compare the two sides without guessing.
 */
export function crossReferenceText(p: OwnContentProfile, library: LibraryTopics): string {
  if (!p.hasPosts) return '';
  const tags = library.tags.filter((t) => t.name).slice(0, 12);
  const cats = library.categories.filter((c) => c.name).slice(0, 6);
  if (!tags.length && !cats.length) return '';
  const L: string[] = [];
  L.push(`Saved vs posted. These counts are exact — use them as they are and do not extrapolate. "posts" means the ${p.posts.length} recent posts listed above.`);
  if (tags.length) {
    L.push('Saved topic: saves in the library / recent posts that mention it');
    for (const t of tags) {
      const hits = p.posts.filter((post) => postMentions(post, t.name));
      L.push(`  - ${t.name}: ${t.n} saves / ${hits.length} of ${p.posts.length} posts${hits.length ? ` (${hits.slice(0, 3).map((h) => `post ${h.id}`).join(', ')})` : ''}`);
    }
    const covered = tags.filter((t) => p.posts.some((post) => postMentions(post, t.name)));
    const missing = tags.filter((t) => !covered.includes(t));
    L.push(`Saved topics that show up in no recent post: ${missing.length ? missing.map((t) => t.name).join(', ') : 'none'}.`);
  }
  if (cats.length) L.push(`Categories they save most: ${cats.map((c) => `${c.name} ${c.n}`).join(', ')}.`);
  return L.join('\n');
}

/* ------------------------------------------------------------------ */
/* Question shape                                                      */
/* ------------------------------------------------------------------ */

const ACCOUNT_RE = /\b(my (account|profile|posts?|reels?|carousels?|stories|story|captions?|content|feed|niche|audience|followers?|numbers|analytics|insights|engagement|reach)|i posted|i post|i publish|what i post|my last (post|reel)|best (time|hour|day) to post|how (am i|did i) do|posting (schedule|cadence|time)|how many (followers|follows|following))\b/i;

const CROSSREF_RE = /(match(es)? what i post|what i save[\s\S]{0,40}what i post|what i post[\s\S]{0,40}what i save|sav\w*[\s\S]{0,20}(vs\.?|versus)[\s\S]{0,20}post|post\w*[\s\S]{0,20}(vs\.?|versus)[\s\S]{0,20}sav|closest to what i (keep )?sav|line up with what i post|align\w*[\s\S]{0,25}what i post|compare (my|what i) sav\w*[\s\S]{0,25}post|do i post what i save|practi[cs]e what i save)/i;

/** True when a question is about the user's own account/posts rather than their saves. */
export function isAccountQuestion(question: string): boolean {
  return ACCOUNT_RE.test(String(question || ''));
}

/** True when a question explicitly compares the library with the account ("does what I save match what I post?"). */
export function isCrossRefQuestion(question: string): boolean {
  return CROSSREF_RE.test(String(question || ''));
}
