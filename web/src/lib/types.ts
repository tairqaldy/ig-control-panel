export interface AnalysisLight {
  title: string;
  one_liner: string;
  category: string;
  subcategory: string;
  tags: string[];
  content_type: string;
  action_type: string;
  usefulness_score: number;
  is_evergreen: boolean;
  vibe: string;
  language: string;
  key_points_count: number;
}

export interface Analysis extends Omit<AnalysisLight, 'key_points_count'> {
  summary: string;
  key_points: string[];
  why_saved_guess: string;
  actionable_takeaways: string[];
  entities: { people: string[]; brands: string[]; tools: string[]; places: string[]; books_media: string[]; products: string[] };
  hook: { text: string; style: string };
  format_notes: string;
  on_screen_text: string;
  quotes: string[];
  resurface_prompt: string;
  remix_idea: string;
  confidence: number;
}

export interface ItemLight {
  id: string;
  url: string;
  shortcode: string | null;
  media_type: 'image' | 'video' | 'carousel' | 'unknown';
  product_type: string | null;
  author: string | null;
  author_name: string | null;
  caption: string | null;
  thumb: string | null;
  frames: string[];
  taken_at: number | null;
  saved_at: number | null;
  saved_rank: number | null;
  like_count: number | null;
  play_count: number | null;
  comment_count: number | null;
  duration: number | null;
  music: string | null;
  location: string | null;
  collections: string[];
  favorite: boolean;
  archived: boolean;
  excluded: boolean;
  saved_at_est: number | null;
  cost_usd: number;
  user_tags: string[];
  has_notes: boolean;
  media_status: string;
  analysis_status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  analysis_error: string | null;
  queue_state: string;
  has_transcript: boolean;
  analysis: AnalysisLight | null;
  why_today?: string;
  score?: number;
}

export interface ItemFull extends Omit<ItemLight, 'analysis'> {
  alt_text: string | null;
  transcript: string | null;
  transcript_lang: string | null;
  user_notes: string | null;
  media_error: string | null;
  analysis_model: string | null;
  analyzed_at: number | null;
  source: string;
  created_at: number;
  updated_at: number;
  last_resurfaced_at: number | null;
  resurface_count: number;
  video: string | null;
  analysis: Analysis | null;
}

export interface ItemsResponse { items: ItemLight[]; total: number; page: number; limit: number; hasMore: boolean }

export interface Scope {
  years: number;
  types: Array<'video' | 'image' | 'carousel'>;
  transcribe: 'all' | 'short' | 'none';
  transcribeMaxSeconds: number;
  frames: number;
  tier: 'standard' | 'economy';
  budgetUsd: number;
}
export interface ScopeReport {
  scope: Scope;
  model: string;
  counts: { total: number; analyzed: number; eligiblePending: number; outOfScope: number; excluded: number; failed: number; queued: number };
  eligibleByType: Record<string, number>;
  estimate: { standard: number; economy: number; perItemStandard: number; perItemEconomy: number; transcribeMinutes: number };
  spent: { total: number; sinceReset: number; items: number; avgPerItem: number; byType: Record<string, { n: number; usd: number }> };
  budget: { cap: number; remaining: number | null; paused: boolean; pauseReason: string | null };
}

export interface WorkerStatus {
  paused: boolean;
  pauseReason: string | null;
  concurrency: number;
  openaiConfigured: boolean;
  queued: number;
  running: number;
  analyzed: number;
  failed: number;
  skipped: number;
  pending: number;
  total: number;
  runningIds: string[];
  processedSinceBoot: number;
  failedSinceBoot: number;
  lastError: string | null;
  recent: Array<{ id: string; ok: boolean; at: number; ms: number; note?: string }>;
  startedAt: number;
}

export interface Stats {
  totals: { total: number; analyzed: number; pending: number; failed: number; skipped: number; videos: number; images: number; carousels: number; transcribed: number; favorites: number; total_seconds: number; authors: number; evergreen: number };
  categories: Array<{ name: string; n: number }>;
  tags: Array<{ name: string; n: number }>;
  authors: Array<{ name: string; full_name: string | null; n: number }>;
  contentTypes: Array<{ name: string; n: number }>;
  actions: Array<{ name: string; n: number }>;
  timeline: Array<{ month: string; n: number }>;
  usefulness: Array<{ score: number; n: number }>;
  languages: Array<{ name: string; n: number }>;
  worker: WorkerStatus;
  lastImport: any;
  igUsername: string | null;
}

export interface Facets {
  tags: Array<{ name: string; n: number }>;
  authors: Array<{ name: string; full_name: string | null; n: number }>;
  categories: Array<{ name: string; n: number }>;
  collections: Array<{ name: string; n: number }>;
  contentTypes: Array<{ name: string; n: number }>;
  allCategories: string[];
}

export interface AskSource {
  id: string;
  title: string;
  one_liner: string;
  author: string | null;
  url: string;
  thumb: string | null;
  category: string | null;
  tags: string[];
  score: number;
}

export interface GraphNode {
  id: string;
  type: 'item' | 'tag' | 'author' | 'category';
  label: string;
  count?: number;
  category?: string;
  thumb?: string | null;
  useful?: number;
  author?: string | null;
  tags?: string[];
}
export interface GraphLink { source: string; target: string; kind: 'tag' | 'author' | 'category' | 'similar'; score?: number }
export interface GraphData { nodes: GraphNode[]; links: GraphLink[]; meta: { items: number; tags: number; authors: number; categories: number } }

/* ---------------- Hosted mode: plans, quotas, billing (docs/dev/HOSTED-SPEC.md §4–§5) ---------------- */
export type PlanId = 'owner' | 'trial' | 'free' | 'pro' | 'studio';
/** Server limits are numbers or Infinity; Infinity serialises to null in JSON → treat null / non-finite as "unlimited". */
export type Limit = number | null;
export interface Limits { analyzeTotal: Limit; analyzePerMonth: Limit; askPerMonth: Limit; askPerMinute: Limit; rules: Limit; sendsPerMonth: Limit; harvestsPerDay: Limit; graphNodes: Limit; concurrency: Limit }
export interface UsageMeter { used: number; limit: Limit }
export type UsageMetric = 'analyze' | 'analyzeMonth' | 'ask' | 'sends' | 'rules' | 'harvests';
export interface PlanInfo {
  plan: PlanId;
  effectivePlan: PlanId;
  status: string;
  trialEndsAt: number | null;
  renewsAt: number | null;
  limits: Limits;
  usage: Record<UsageMetric, UsageMeter>;
  paddle: { env: 'sandbox' | 'production'; clientToken: string | null; prices: { proMonth: string | null; proYear: string | null; studioMonth: string | null; studioYear: string | null } };
  canManage: boolean;
}
/** Body of an HTTP 402 response (dispatched on window as the `rs:quota` CustomEvent detail). */
export interface QuotaError { error: string; code: 'quota'; metric: string; window?: 'total' | 'month' | 'day' | 'minute' | null; used: number; limit: Limit; remaining?: Limit; resetsAt?: number | null; plan: PlanId; upgrade: true }
/** GET /api/plans (public catalog). The web tolerates a few shapes — see components/Pricing.tsx normalizeCatalog(). */
export interface PlanCatalogEntry { id: PlanId; name: string; blurb?: string; monthly: number | null; yearly: number | null; priceIds: { month: string | null; year: string | null }; limits: Limits }
export interface PlansCatalog { trialDays: number; plans: PlanCatalogEntry[] }
export interface QueueResponse extends WorkerStatus { justQueued: number; leftOut?: number; quota?: { used: number; limit: Limit; remaining: number; plan?: PlanId } }

export interface Rule {
  id: number;
  name: string;
  enabled: number;
  trigger_type: 'dm_keyword' | 'dm_any' | 'comment_keyword' | 'comment_any' | 'story_reply';
  match_mode: 'contains' | 'exact' | 'starts_with' | 'regex';
  keywords: string;
  reply_text: string;
  reply_link: string | null;
  public_reply_text: string | null;
  cooldown_minutes: number;
  priority: number;
  hit_count: number;
  last_hit_at: number | null;
  created_at: number;
  updated_at: number;
}
