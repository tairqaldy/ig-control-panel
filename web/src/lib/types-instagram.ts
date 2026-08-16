/* Round 5 — Instagram connect, analytics, Companion (docs/dev/ROUND5-SPEC.md §1–§5). Web-side contracts. */

/* ---------------- §1 Connect ---------------- */
export interface IgAccount {
  igUserId: string;
  username: string | null;
  name: string | null;
  profilePictureUrl: string | null;
  accountType: string | null;
  followersCount: number | null;
  followsCount: number | null;
  mediaCount: number | null;
  connectedAt: number | null;
  tokenExpiresAt: number | null;
  webhookSubscribed: boolean | number | null;
}
/** GET /api/instagram/account */
export interface IgAccountResponse {
  connected: boolean;
  /** META_APP_ID present on this server → one-click connect is possible */
  configured: boolean;
  account?: IgAccount | null;
  source: 'oauth' | 'env' | null;
  /** set by the web when the endpoint is missing (older server) — never sent by the server */
  unavailable?: boolean;
}

/* ---------------- §3 Analytics ---------------- */
export type AnalyticsRange = 7 | 30 | 90;
export interface AnalyticsMedia {
  id: string;
  caption: string | null;
  type: string | null;          // IMAGE | VIDEO | CAROUSEL_ALBUM
  productType: string | null;   // FEED | REELS | STORY
  thumb: string | null;
  permalink: string | null;
  timestamp: number | null;     // unix seconds
  likes: number | null;
  comments: number | null;
  reach: number | null;
  saved: number | null;
  shares: number | null;
  views: number | null;
  engagementRate: number | null; // percent of reach (3.4 = 3.4%)
}
export interface AnalyticsResponse {
  connected: boolean;
  configured?: boolean;
  demo: boolean;
  /** a background refresh is running right now (server sets it when the cached data is stale) */
  refreshing?: boolean;
  refreshedAt: number | null;
  range?: AnalyticsRange;
  account: { username: string | null; name: string | null; profilePictureUrl: string | null; followers: number | null; follows: number | null; media: number | null } | null;
  series: { days: string[]; followers: Array<number | null>; newFollowers?: Array<number | null>; reach: Array<number | null> };
  totals: { profileViews: number | null; accountsEngaged: number | null; interactions: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; replies: number | null; websiteClicks: number | null; newFollowers?: number | null };
  media: AnalyticsMedia[];
  derived: {
    bestHours: Array<{ hour: number; score: number; posts?: number }>;   // score 0..1, hours in the client's tz (we send ?tzOffset=)
    bestDays: Array<{ weekday: number; label?: string; score: number; posts?: number }>; // 0 = Sunday … 6 = Saturday
    contentMix: { reels: number; carousels: number; images: number };
    topBySaves: string[];
    topByReach: string[];
    avgEngagementRate: number | null; // percent
    postingCadencePerWeek: number;
    hashtags: Array<{ tag: string; uses: number; avgReach: number | null }>;
    tzOffsetMinutes?: number;
  };
}
/** POST /api/instagram/analytics/refresh 429-style body (retryAt = unix seconds) */
export interface RefreshThrottled { error: string; code?: 'too_soon' | 'not_connected'; retryAt?: number | null; refreshedAt?: number | null }

/* ---------------- §2 Starter rules ---------------- */
/** Keys match server/src/services/instagram.ts STARTER_TEMPLATES */
export type StarterKey = 'comment_link' | 'dm_welcome' | 'story_thanks';
/** POST /api/automations/starter → the starter rules (existing + just created), each tagged with its key */
export interface StarterRulesResponse<R = unknown> { rules: Array<R & { starter_key: StarterKey }>; created: number; leftOut: number; quota: unknown; skipped: 'has_rules' | null }

/* ---------------- §4 Companion ---------------- */
export interface PairCode { code: string; expiresAt: number }
export interface CompanionDevice {
  id: number;
  name: string | null;
  createdAt: number | null;
  lastSeenAt: number | null;
  lastHarvestAt: number | null;
  lastHarvestCount: number | null;
  ua: string | null;
  /** opted in to server-side harvesting (encrypted Instagram session stored) */
  serverHarvest: boolean;
  igSessionStatus: 'ok' | 'invalid' | null;
  igSessionCheckedAt: number | null;
}
/** GET /api/companion/devices → { devices, notice, serverHarvest: { available }, runs } (normalised by fetchCompanionDevices) */
export interface CompanionDevicesResponse {
  devices: CompanionDevice[];
  /** per-tenant notice written by the server harvest job (meta `companion_notice`) */
  notice?: string | null;
  serverHarvestEnabled?: boolean;
  unavailable?: boolean;
}
