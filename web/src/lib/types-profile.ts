/* Instagram Profile Score (ROUND7 §4) — the web contract.
 *
 *   GET  /api/profile/questions            → { questions, goals, subject }
 *   POST /api/profile/goals { goal, … }    → { goals }
 *   GET  /api/profile/score                → ProfileScorePayload (free, no model call)
 *   POST /api/profile/score { manual?, goals? } → ProfileScorePayload; 1 credit on the `ask` metric
 *
 * The server answers its failure cases with the *same* payload plus a `code`: `rate_limited` (429),
 * `profile_required` (400), `ai_unavailable` (503), and a 200 with `stale: true` when the model was
 * unreachable but an older report exists. So every one of them still renders a real page.
 *
 * The readers below take a couple of spellings (snake_case out of SQLite, report nested or flat)
 * because the two halves ship in parallel; an unreadable shape degrades to "no report yet".
 */

/* ---------------- dimensions ---------------- */

export type ProfileDimensionId = 'name_handle' | 'bio' | 'photo' | 'positioning' | 'settings';
export const DIMENSION_IDS: ProfileDimensionId[] = ['name_handle', 'bio', 'photo', 'positioning', 'settings'];
export const DIMENSION_LABEL: Record<ProfileDimensionId, string> = {
  name_handle: 'Name and handle',
  bio: 'Bio',
  photo: 'Profile photo',
  positioning: 'Positioning',
  settings: 'Account settings',
};
/** One line of what the dimension covers — a row means something before it is expanded. */
export const DIMENSION_HINT: Record<ProfileDimensionId, string> = {
  name_handle: 'The Name field Instagram searches, and a handle people can spell.',
  bio: 'The 150 characters that decide whether a visitor follows.',
  photo: 'How the picture reads at 40 pixels wide.',
  positioning: 'Whether the profile says one thing, and whether that thing is your goal.',
  settings: 'Account type, category, contact buttons, link, highlights.',
};

export type FixEffort = 'minute' | 'hour' | 'project';
export const EFFORT_LABEL: Record<FixEffort, string> = { minute: 'a minute', hour: 'an hour', project: 'a project' };

export interface ProfileFix { what: string; why: string; effort: FixEffort; example: string | null }
export interface ProfileDimension { id: ProfileDimensionId; score: number | null; verdict: string; fixes: ProfileFix[] }
/** A paste-ready bio plus two to four words naming its angle. */
export interface BioRewrite { text: string; angle: string | null }

export interface ProfileReport {
  overall: number | null;
  /** One sentence: what the profile does well and what holds it back. */
  headline: string | null;
  dimensions: ProfileDimension[];
  bioRewrites: BioRewrite[];
  nextThree: ProfileFix[];
  /** Facts the model was not given — the page says these were not checked instead of implying they were. */
  notChecked: string[];
}
export interface ProfileScoreRecord extends ProfileReport { id: number | null; createdAt: number | null }

export type SubjectSource = 'instagram' | 'manual' | 'mixed' | 'none';

/** What was scored: the Instagram account, the pasted fields, or a merge of both. */
export interface ProfileSubject {
  source: SubjectSource;
  connected: boolean;
  /** these fields came from a paste — never imply a connection */
  manual: boolean;
  username: string | null;
  name: string | null;
  bio: string | null;
  link: string | null;
  followers: number | null;
  posts: number | null;
  accountType: string | null;
  profilePictureUrl: string | null;
  missing: string[];
}

export interface ProfileGoals { goal: string | null; niche: string | null; audience: string | null; offer: string | null; tone: string | null }
export const EMPTY_GOALS: ProfileGoals = { goal: null, niche: null, audience: null, offer: null, tone: null };
export type GoalKey = keyof ProfileGoals;
export const GOAL_KEYS: GoalKey[] = ['goal', 'niche', 'audience', 'offer', 'tone'];

/** How the last call ended — drives what the page says, not whether it renders. */
export type ScoreOutcome = 'ok' | 'stale' | 'rate_limited' | 'profile_required' | 'ai_unavailable';

export interface ProfileScoreState {
  score: ProfileScoreRecord | null;
  previous: { overall: number | null; createdAt: number | null } | null;
  delta: number | null;
  stale: boolean;
  staleReason: string | null;
  subject: ProfileSubject | null;
  goals: ProfileGoals | null;
  /** false = there is not enough profile to score yet (no handle and no bio) */
  canScore: boolean;
  /** seconds left on the 10-minute re-score limit; 0 when a run is allowed */
  cooldownSeconds: number;
  nextScoreAt: number | null;
  cost: { credits: number; metric: string } | null;
  /** `ok: false` — the report shipped but the credit could not be taken; the page says so instead of "Scored." */
  charged: { creditsSpent: number; balance: number | null; ok?: boolean } | null;
  outcome: ScoreOutcome;
  /** the server's own sentence for this outcome, shown verbatim */
  message: string | null;
  /** this build of the server does not have the endpoints (404) */
  unavailable: boolean;
}

export interface ProfileQuestionOption { value: string; label: string; hint: string | null }
export interface ProfileQuestion {
  /** a column of `profile_goals`: goal · niche · audience · offer · tone */
  id: string;
  title: string;
  help: string | null;
  options: ProfileQuestionOption[];
  allowOther: boolean;
  otherLabel: string | null;
  placeholder: string | null;
  /** our suggestion, or the saved answer when there is one */
  prefill: string | null;
  /** where the suggestion came from, in words the person can check */
  prefillFrom: string | null;
  /** true when `prefill` is what they answered last time rather than a guess */
  answered: boolean;
}
export interface ProfileQuestionsState {
  questions: ProfileQuestion[];
  goals: ProfileGoals | null;
  subject: ProfileSubject | null;
  unavailable: boolean;
}

/* ---------------- readers ---------------- */

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => {
  if (typeof v === 'string') { const s = v.trim(); return s ? s : null; }
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
};
const clampScore = (v: unknown): number | null => { const n = num(v); return n === null ? null : Math.max(0, Math.min(100, Math.round(n))); };
/** epoch seconds; a millisecond timestamp would otherwise render as the year 57000 */
const secs = (v: unknown): number | null => { const n = num(v); return n === null ? null : n > 1e12 ? Math.floor(n / 1000) : Math.round(n); };
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s): s is string => !!s) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

function effortOf(v: unknown): FixEffort {
  const s = (str(v) || '').toLowerCase();
  if (s.startsWith('hour')) return 'hour';
  if (s.startsWith('project') || s.startsWith('week') || s.startsWith('day')) return 'project';
  return 'minute';
}

function fixFrom(raw: unknown): ProfileFix | null {
  if (typeof raw === 'string') { const what = str(raw); return what ? { what, why: '', effort: 'minute', example: null } : null; }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const what = str(r.what ?? r.action ?? r.title ?? r.fix ?? r.label);
  if (!what) return null;
  return { what, why: str(r.why ?? r.reason ?? r.rationale) ?? '', effort: effortOf(r.effort ?? r.cost ?? r.size), example: str(r.example ?? r.sample ?? r.suggestion) };
}

function dimensionFrom(id: ProfileDimensionId, raw: unknown): ProfileDimension {
  const r = obj(raw);
  const fixesRaw = Array.isArray(r.fixes) ? r.fixes : Array.isArray(r.actions) ? r.actions : [];
  return {
    id,
    score: clampScore(r.score ?? r.value ?? r.rating),
    verdict: str(r.verdict ?? r.summary ?? r.comment ?? r.note) ?? '',
    fixes: fixesRaw.map(fixFrom).filter((f): f is ProfileFix => !!f).slice(0, 3),
  };
}

/** Keyed (`dimensions.bio`), listed (`[{ id: 'bio' }]`), or flat on the report itself (`report.bio`). */
function dimensionsFrom(src: Record<string, unknown>): ProfileDimension[] {
  const raw = src.dimensions ?? src.scores ?? src.breakdown;
  if (Array.isArray(raw)) {
    const byId = new Map<string, unknown>();
    for (const row of raw) { const key = str(obj(row).id ?? obj(row).key ?? obj(row).dimension ?? obj(row).name); if (key) byId.set(key, row); }
    return DIMENSION_IDS.map((id) => dimensionFrom(id, byId.get(id)));
  }
  const keyed = obj(raw);
  return DIMENSION_IDS.map((id) => dimensionFrom(id, keyed[id] ?? src[id]));
}

function rewriteFrom(raw: unknown): BioRewrite | null {
  if (typeof raw === 'string') { const text = str(raw); return text ? { text, angle: null } : null; }
  const r = obj(raw);
  const text = str(r.text ?? r.bio ?? r.value);
  return text ? { text, angle: str(r.angle ?? r.label) } : null;
}

/** The report is nested under `score.report` (the API) or JSON-encoded in `json` (the raw row). */
function reportSource(raw: Record<string, unknown>): Record<string, unknown> {
  const nested = raw.report ?? raw.result ?? raw.analysis ?? raw.json ?? raw.data;
  if (typeof nested === 'string') { try { const p: unknown = JSON.parse(nested); if (p && typeof p === 'object') return { ...raw, ...(p as Record<string, unknown>) }; } catch { /* not JSON — fall through */ } }
  if (nested && typeof nested === 'object') return { ...raw, ...(nested as Record<string, unknown>) };
  return raw;
}

function recordFrom(raw: unknown): ProfileScoreRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = reportSource(raw as Record<string, unknown>);
  const dimensions = dimensionsFrom(src);
  const overall = clampScore(src.overall ?? src.score ?? src.total);
  const bioRewrites = (Array.isArray(src.bio_rewrites ?? src.bioRewrites ?? src.rewrites) ? (src.bio_rewrites ?? src.bioRewrites ?? src.rewrites) as unknown[] : [])
    .map(rewriteFrom).filter((b): b is BioRewrite => !!b).slice(0, 3);
  const nextThree = (Array.isArray(src.next_three ?? src.nextThree ?? src.next) ? (src.next_three ?? src.nextThree ?? src.next) as unknown[] : [])
    .map(fixFrom).filter((f): f is ProfileFix => !!f).slice(0, 3);
  // A record with nothing in it is not a report — the empty state beats five blank rows.
  if (overall === null && !dimensions.some((d) => d.score !== null || d.verdict) && !bioRewrites.length && !nextThree.length) return null;
  return {
    id: num(src.id),
    createdAt: secs(src.created_at ?? src.createdAt ?? src.generatedAt ?? src.at),
    overall,
    headline: str(src.headline),
    dimensions,
    bioRewrites,
    nextThree,
    notChecked: strList(src.notChecked ?? src.not_checked ?? src.missing),
  };
}

export function normalizeSubject(raw: unknown): ProfileSubject | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const source = ((): SubjectSource => {
    const s = str(r.source);
    return s === 'instagram' || s === 'manual' || s === 'mixed' || s === 'none' ? s : 'none';
  })();
  const manual = r.manual === undefined ? source === 'manual' : !!r.manual;
  const s: ProfileSubject = {
    source,
    // A pasted profile is not a connection: only say connected when the server does, or when the data came from Instagram.
    connected: r.connected === undefined ? source === 'instagram' || source === 'mixed' : !!r.connected,
    manual,
    username: str(r.username ?? r.handle)?.replace(/^@/, '') ?? null,
    name: str(r.name ?? r.full_name ?? r.fullName),
    bio: str(r.bio ?? r.biography ?? r.description),
    link: str(r.link ?? r.website ?? r.url),
    followers: num(r.followers ?? r.followers_count ?? r.followersCount),
    posts: num(r.posts ?? r.mediaCount ?? r.media_count),
    accountType: str(r.accountType ?? r.account_type),
    profilePictureUrl: str(r.profilePictureUrl ?? r.profile_picture_url ?? r.photoUrl ?? r.avatar),
    missing: strList(r.missing ?? r.notChecked),
  };
  return s;
}

function goalsFrom(raw: unknown): ProfileGoals | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const g: ProfileGoals = { goal: str(r.goal), niche: str(r.niche), audience: str(r.audience), offer: str(r.offer), tone: str(r.tone) };
  return GOAL_KEYS.some((k) => g[k]) ? g : null;
}

function outcomeFrom(r: Record<string, unknown>): ScoreOutcome {
  const code = str(r.code);
  if (code === 'rate_limited' || code === 'profile_required' || code === 'ai_unavailable') return code;
  return r.stale ? 'stale' : 'ok';
}

export function normalizeScoreState(raw: unknown): ProfileScoreState {
  const r = obj(raw);
  const score = recordFrom(r.score ?? r.latest ?? r.current ?? r);
  const previousRaw = obj(r.previous ?? r.prev);
  const prevOverall = clampScore(previousRaw.overall ?? previousRaw.score);
  const subject = normalizeSubject(r.subject ?? r.profile ?? r.account);
  const outcome = outcomeFrom(r);
  const delta = num(r.delta) ?? (score?.overall !== null && score?.overall !== undefined && prevOverall !== null ? score.overall - prevOverall : null);
  const message = str(r.message ?? r.error ?? r.staleReason ?? r.stale_reason);
  const cost = obj(r.cost);
  const charged = r.charged && typeof r.charged === 'object' ? obj(r.charged) : null;
  return {
    score,
    previous: prevOverall === null ? null : { overall: prevOverall, createdAt: secs(previousRaw.createdAt ?? previousRaw.created_at) },
    delta,
    // A 503 leaves `stale` false on the payload but the report on screen is still the older one.
    stale: !!r.stale || outcome === 'ai_unavailable',
    staleReason: str(r.staleReason ?? r.stale_reason) ?? (outcome === 'ai_unavailable' ? message : null),
    subject,
    goals: goalsFrom(r.goals),
    // Same rule as the server's canScore: a bio, plus a handle or a name to attach it to.
    canScore: r.canScore === undefined ? !!(subject?.bio && (subject?.username || subject?.name)) : !!r.canScore,
    cooldownSeconds: Math.max(0, num(r.cooldownSeconds ?? r.cooldown_seconds ?? r.retryAfter ?? r.retry_after) ?? 0),
    nextScoreAt: secs(r.nextScoreAt ?? r.next_score_at ?? r.retryAt),
    cost: num(cost.credits) !== null ? { credits: num(cost.credits) as number, metric: str(cost.metric) ?? 'ask' } : null,
    charged: charged ? { creditsSpent: num(charged.creditsSpent) ?? 0, balance: num(charged.balance), ok: charged.ok !== false } : null,
    outcome,
    message,
    unavailable: false,
  };
}

export const EMPTY_SCORE_STATE: ProfileScoreState = {
  score: null, previous: null, delta: null, stale: false, staleReason: null, subject: null, goals: null,
  canScore: false, cooldownSeconds: 0, nextScoreAt: null, cost: null, charged: null, outcome: 'ok', message: null, unavailable: false,
};

function optionFrom(raw: unknown): ProfileQuestionOption | null {
  if (typeof raw === 'string') { const v = str(raw); return v ? { value: v, label: v, hint: null } : null; }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const value = str(r.value ?? r.id ?? r.key ?? r.label);
  if (!value) return null;
  return { value, label: str(r.label ?? r.title ?? r.text) ?? value, hint: str(r.hint ?? r.help ?? r.detail) };
}

function questionFrom(raw: unknown): ProfileQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id ?? r.key ?? r.field ?? r.name);
  const title = str(r.title ?? r.question ?? r.label ?? r.text);
  if (!id || !title) return null;
  const options = (Array.isArray(r.options) ? r.options : Array.isArray(r.choices) ? r.choices : []).map(optionFrom).filter((o): o is ProfileQuestionOption => !!o);
  const answer = str(r.answer);
  return {
    id,
    title,
    help: str(r.help ?? r.hint ?? r.subtitle ?? r.description),
    options,
    // Free text is always allowed unless the server says otherwise — an option list is a shortcut, not a cage.
    allowOther: r.allowOther === undefined && r.allow_other === undefined ? true : !!(r.allowOther ?? r.allow_other),
    otherLabel: str(r.otherLabel ?? r.other_label),
    placeholder: str(r.placeholder ?? r.otherPlaceholder ?? r.other_placeholder),
    prefill: answer ?? str(r.prefill ?? r.value ?? r.default ?? r.suggested),
    prefillFrom: str(r.prefillFrom ?? r.prefill_from),
    answered: !!answer,
  };
}

/**
 * Used only when the server answers with no questions at all (an older build). The five ids match
 * `profile_goals`, so the answers still save and still score.
 */
export const FALLBACK_QUESTIONS: ProfileQuestion[] = [
  {
    id: 'goal', title: 'What is this account for?', help: 'It decides what the bio has to do.',
    options: [
      { value: 'personal_brand', label: 'A personal brand', hint: 'People follow you, not a company' },
      { value: 'business', label: 'A business', hint: 'The account sells a product or a service' },
      { value: 'creator', label: 'A creator account', hint: 'Reach and brand deals are the point' },
      { value: 'community', label: 'A community', hint: 'A place for people around one topic' },
    ],
    allowOther: true, otherLabel: 'Something else', placeholder: 'In a few words', prefill: null, prefillFrom: null, answered: false,
  },
  { id: 'niche', title: 'What is it about?', help: 'One topic reads better than five.', options: [], allowOther: true, otherLabel: 'A different topic', placeholder: 'e.g. sourdough baking', prefill: null, prefillFrom: null, answered: false },
  {
    id: 'audience', title: 'Who should follow you?', help: 'The bio speaks to one person.',
    options: [
      { value: 'beginners', label: 'Beginners in my topic', hint: null },
      { value: 'professionals', label: 'People who already do this for work', hint: null },
      { value: 'local', label: 'People near me', hint: null },
      { value: 'creators', label: 'Other creators', hint: null },
    ],
    allowOther: true, otherLabel: 'Someone else', placeholder: 'Describe them in a few words', prefill: null, prefillFrom: null, answered: false,
  },
  {
    id: 'offer', title: 'What do you want people to do?', help: 'This is what the link and the call to action are for.',
    options: [
      { value: 'nothing_yet', label: 'Nothing yet — I want an audience first', hint: null },
      { value: 'digital_product', label: 'A digital product', hint: 'Course, template, ebook' },
      { value: 'services', label: 'Services', hint: 'Freelance, coaching, consulting' },
      { value: 'physical', label: 'Physical products', hint: null },
    ],
    allowOther: true, otherLabel: 'Something else', placeholder: 'e.g. book a table', prefill: null, prefillFrom: null, answered: false,
  },
  {
    id: 'tone', title: 'How should it sound?', help: 'The rewrites will be written in this voice.',
    options: [
      { value: 'friendly', label: 'Friendly', hint: null },
      { value: 'direct', label: 'Direct', hint: null },
      { value: 'playful', label: 'Playful', hint: null },
      { value: 'expert', label: 'Expert', hint: null },
      { value: 'calm', label: 'Calm', hint: null },
    ],
    allowOther: true, otherLabel: 'A different tone', placeholder: 'e.g. dry and technical', prefill: null, prefillFrom: null, answered: false,
  },
];

export function normalizeQuestions(raw: unknown): ProfileQuestionsState {
  const r = obj(raw);
  const list = Array.isArray(raw) ? (raw as unknown[]) : Array.isArray(r.questions) ? r.questions : [];
  const parsed = list.map(questionFrom).filter((q): q is ProfileQuestion => !!q);
  const goals = goalsFrom(r.goals);
  const questions = (parsed.length ? parsed : FALLBACK_QUESTIONS.map((q) => ({ ...q }))).map((q) => {
    // A saved answer wins over a suggestion: reopening the questionnaire shows what you chose.
    const saved = goals && (GOAL_KEYS as string[]).includes(q.id) ? goals[q.id as GoalKey] : null;
    return saved ? { ...q, prefill: saved, answered: true } : q;
  });
  return { questions, goals, subject: normalizeSubject(r.subject ?? r.profile ?? r.account), unavailable: false };
}

/* ---------------- small helpers the UI shares ---------------- */

export type ScoreTone = 'good' | 'ok' | 'weak';
export function scoreTone(score: number | null | undefined): ScoreTone {
  if (score === null || score === undefined) return 'ok';
  return score >= 75 ? 'good' : score >= 50 ? 'ok' : 'weak';
}
/** Text colour per tone — the ring, the row numbers and the overall figure all read from here. */
export const TONE_TEXT: Record<ScoreTone, string> = { good: 'text-accent', ok: 'text-warn', weak: 'text-danger' };
export const TONE_BAR: Record<ScoreTone, string> = { good: 'bg-accent', ok: 'bg-warn', weak: 'bg-danger' };
export const TONE_STROKE: Record<ScoreTone, string> = { good: 'var(--accent)', ok: 'var(--warn)', weak: 'var(--danger)' };

/** One-word reading of the overall number, so 62 means something without a legend. */
export function overallLabel(score: number | null | undefined): string {
  if (score === null || score === undefined) return 'Not scored yet';
  if (score >= 85) return 'Strong';
  if (score >= 70) return 'Solid, with gaps';
  if (score >= 50) return 'Half-finished';
  if (score >= 30) return 'Needs work';
  return 'Barely set up';
}

/** "in 7 minutes" for the re-score limit. */
export function cooldownLabel(seconds: number): string {
  if (seconds <= 0) return '';
  const m = Math.ceil(seconds / 60);
  return m <= 1 ? 'in a minute' : `in ${m} minutes`;
}

export const BIO_MAX = 150;
