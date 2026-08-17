/** Normalized item as produced by the harvester / importers (input shape). */
export interface HarvestItem {
  pk?: string;
  code?: string;
  url?: string;
  taken_at?: number | null;
  saved_at?: number | null;
  media_type?: number | string | null; // 1 image, 2 video, 8 carousel
  product_type?: string | null; // clips | feed | carousel_container | igtv
  caption?: string | null;
  alt_text?: string | null;
  user?: { pk?: string; username?: string; full_name?: string; is_verified?: boolean; profile_pic_url?: string } | null;
  like_count?: number | null;
  comment_count?: number | null;
  play_count?: number | null;
  view_count?: number | null;
  video_duration?: number | null;
  location?: { name?: string } | string | null;
  music?: { title?: string; artist?: string } | null;
  original_audio?: string | null;
  thumb?: { url: string; width?: number; height?: number } | null;
  video?: { url: string; width?: number; height?: number } | null;
  carousel?: Array<{ pk?: string; media_type?: number; thumb?: { url: string } | null; video?: { url: string } | null; alt_text?: string | null }> | null;
  collections?: string[] | null;
  usertags?: string[] | null;
  coauthors?: string[] | null;
  is_paid_partnership?: boolean | null;
  has_audio?: boolean | null;
}

export interface HarvestFile {
  format: string; // 'resurface-harvest'
  version: number;
  exported_at?: number;
  account?: { ds_user_id?: string; username?: string };
  collections?: Array<{ id: string; name: string; count?: number }>;
  items: HarvestItem[];
}

export type MediaType = 'image' | 'video' | 'carousel' | 'unknown';

export interface MediaUrls {
  thumb?: string | null;
  video?: string | null;
  carousel?: Array<{ type: 'image' | 'video'; thumb?: string | null; video?: string | null }>;
}

/** The structured analysis produced by the LLM (see prompts/analysis.ts for the JSON schema). */
export interface Analysis {
  title: string;
  one_liner: string;
  summary: string;
  key_points: string[];
  category: string;
  subcategory: string;
  tags: string[];
  content_type: string;
  why_saved_guess: string;
  actionable_takeaways: string[];
  action_type: string;
  entities: {
    people: string[];
    brands: string[];
    tools: string[];
    places: string[];
    books_media: string[];
    products: string[];
  };
  hook: { text: string; style: string };
  format_notes: string;
  on_screen_text: string;
  quotes: string[];
  language: string;
  vibe: string;
  usefulness_score: number;
  is_evergreen: boolean;
  resurface_prompt: string;
  remix_idea: string;
  confidence: number;
}

export interface ItemRow {
  id: string;
  tenant_id: number;
  ig_pk: string | null;
  shortcode: string | null;
  url: string;
  source: string;
  media_type: MediaType;
  product_type: string | null;
  author_username: string | null;
  author_name: string | null;
  author_pk: string | null;
  author_verified: number;
  author_pic_url: string | null;
  caption: string | null;
  alt_text: string | null;
  location: string | null;
  music_title: string | null;
  music_artist: string | null;
  like_count: number | null;
  comment_count: number | null;
  play_count: number | null;
  duration: number | null;
  taken_at: number | null;
  saved_at: number | null;
  saved_rank: number | null;
  collections: string | null;
  media_urls: string | null;
  media_urls_fetched_at: number | null;
  raw: string | null;
  media_status: string;
  media_error: string | null;
  thumb_path: string | null;
  frames: string | null;
  video_path: string | null;
  transcript: string | null;
  transcript_lang: string | null;
  analysis_status: string;
  analysis_error: string | null;
  analysis: string | null;
  analysis_model: string | null;
  analyzed_at: number | null;
  embedding: Buffer | null;
  embedding_model: string | null;
  queue_state: string;
  queued_at: number | null;
  attempts: number;
  favorite: number;
  archived: number;
  user_notes: string | null;
  user_tags: string | null;
  last_resurfaced_at: number | null;
  resurface_count: number;
  excluded: number;
  exclude_reason: string | null;
  saved_at_est: number | null;
  usage: string | null;
  cost_usd: number;
  created_at: number;
  updated_at: number;
}

/* ---------------- hosted mode: tenants / users ---------------- */

export type PlanId = 'owner' | 'trial' | 'free' | 'pro' | 'studio';
export type PlanStatus = 'active' | 'trialing' | 'past_due' | 'paused' | 'canceled';

export interface TenantRow {
  id: number;
  name: string | null;
  plan: PlanId;
  plan_status: PlanStatus;
  trial_ends_at: number | null;
  plan_started_at: number | null;
  plan_renews_at: number | null;
  paddle_customer_id: string | null;
  paddle_subscription_id: string | null;
  paddle_price_id: string | null;
  created_at: number;
  updated_at: number;
  cancelled_at: number | null;
  deleted_at: number | null;
  /** migration 009: 1 = locked until a card is on file. Tenants that existed before the paywall are 0 forever. */
  requires_payment?: number;
  paywall_cleared_at?: number | null;
}

export interface UserRow {
  id: number;
  tenant_id: number;
  email: string;
  password_hash: string | null;
  is_owner: number;
  created_at: number;
  last_login_at: number | null;
}

/** Session as decoded from the cookie (and attached to the Hono context by `requireAuth`). */
export interface TenantSession {
  u: string;
  tid: number;
  uid: number;
  isOwner: boolean;
}
