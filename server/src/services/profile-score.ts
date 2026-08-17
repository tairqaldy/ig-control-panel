/**
 * Instagram Profile Score (ROUND7-SPEC §4).
 *
 * Scores an Instagram profile out of 100 across five dimensions — name/handle, bio, photo, positioning, settings —
 * against the goals the person states in a five-question questionnaire, and returns paste-ready fixes.
 *
 * Three constraints shape everything here:
 *
 * 1. **It must work without an Instagram connection.** Our Meta app is not Live, so most people cannot connect at all.
 *    A pasted `{ username, name, bio, link }` is a first-class input, stored in `meta` under `profile_manual`, and the
 *    report says plainly which parts could not be checked instead of pretending it measured them.
 * 2. **Never invent numbers.** Only measured facts reach the prompt (the cached `ig_media` rows, the library counts),
 *    and the system prompt forbids inventing the rest. What we do not have is listed as "not checked" by us, not by
 *    the model.
 * 3. **Never a bare 500.** No OpenAI credit, a refusal, a timeout — the last stored report comes back with
 *    `stale: true` and nothing is charged. Only a tenant with no report at all sees an error, and it explains itself.
 *
 * A run costs 1 credit (metric `ask`) charged through `chargeMetered` after the model answers, and re-scoring is
 * limited to once per 10 minutes so a stuck UI cannot drain a balance.
 */
import { db, getMeta, j, now, setMeta } from '../db.js';
import { generateStructured, hasOpenAI, isQuotaError, models, noteQuotaFailure, quotaBlocked } from './openai.js';
import { chargeMetered } from './plans.js';
import { ownContentProfile } from './ig-content.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export const GOAL_FIELDS = ['goal', 'niche', 'audience', 'offer', 'tone'] as const;
export type GoalField = (typeof GOAL_FIELDS)[number];

/** The questionnaire answers. Every field is free text: an "other" answer is stored exactly as typed. */
export type ProfileGoals = Record<GoalField, string | null> & { updatedAt: number };

export const PROFILE_DIMENSIONS = ['name_handle', 'bio', 'photo', 'positioning', 'settings'] as const;
export type ProfileDimensionKey = (typeof PROFILE_DIMENSIONS)[number];

export type FixEffort = 'minute' | 'hour' | 'project';
export interface ProfileFix { what: string; why: string; effort: FixEffort; example: string | null }
export interface ProfileDimension { score: number; verdict: string; fixes: ProfileFix[] }
export interface BioRewrite { text: string; angle: string; length: number }

export interface ProfileReport {
  overall: number;
  headline: string;
  dimensions: Record<ProfileDimensionKey, ProfileDimension>;
  bioRewrites: BioRewrite[];
  nextThree: ProfileFix[];
  /** What the model was NOT given — written by us, never by the model, so the page can say what it could not check. */
  notChecked: string[];
  /** The profile as it looked when this report was written, so an old report still explains itself. */
  subject: ReportSubject;
  goals: Record<GoalField, string | null>;
  model: string;
  generatedAt: number;
}

export interface ReportSubject {
  source: SubjectSource;
  username: string | null;
  name: string | null;
  bio: string | null;
  link: string | null;
  followers: number | null;
  posts: number | null;
}

export type SubjectSource = 'instagram' | 'manual' | 'mixed' | 'none';

export interface ProfileSubject extends ReportSubject {
  connected: boolean;
  /** True when these fields came from a paste rather than the Graph API — the page must not imply a connection. */
  manual: boolean;
  accountType: string | null;
  profilePictureUrl: string | null;
  follows: number | null;
  /** Measured posting cadence/mix, present only when we have cached posts. */
  cadence: { postsPerWeek: number | null; sampled: number; formats: Array<{ format: string; posts: number }> } | null;
  manualUpdatedAt: number | null;
  /** Facts we do not have. Shown to the person and handed to the prompt as "do not comment on these". */
  missing: string[];
}

export interface ProfileQuestionOption { value: string; label: string; hint?: string }
export interface ProfileQuestion {
  id: GoalField;
  title: string;
  help: string;
  options: ProfileQuestionOption[];
  /** Every question takes a free-text answer; the option list is a shortcut, never a cage. */
  allowOther: boolean;
  otherLabel: string;
  placeholder: string;
  /** Our suggested answer (an option value, or free text when we inferred it from their data). */
  prefill: string | null;
  /** Where the suggestion came from, in words the person can check. Null when there was nothing to go on. */
  prefillFrom: string | null;
  answer: string | null;
}

export interface ScoreRow { id: number; createdAt: number; overall: number; report: ProfileReport }

export interface ProfileScorePayload {
  score: ScoreRow | null;
  previous: { id: number; createdAt: number; overall: number } | null;
  /** overall − previous.overall, so the page can show the week-on-week move. */
  delta: number | null;
  stale: boolean;
  staleReason: string | null;
  goals: ProfileGoals | null;
  subject: ProfileSubject;
  /** Mirrors `subject.connected`. A pasted profile is not a connection, and the page must not imply one. */
  connected: boolean;
  canScore: boolean;
  /** Seconds until a re-score is allowed; 0 when it is allowed now. */
  cooldownSeconds: number;
  /** Unix seconds when the next run is allowed, null when it is allowed now. */
  retryAt: number | null;
  cost: { credits: number; metric: 'ask' };
  /** `ok: false` means the report shipped but the credit could not be taken — the page says so instead of "Scored." */
  charged: { creditsSpent: number; balance: number; ok?: boolean } | null;
}

export type ScoreOutcome =
  | { status: 'ok'; payload: ProfileScorePayload }
  | { status: 'stale'; message: string; payload: ProfileScorePayload }
  | { status: 'rate_limited'; retryAfter: number; message: string; payload: ProfileScorePayload }
  | { status: 'needs_profile'; message: string; payload: ProfileScorePayload }
  | { status: 'unavailable'; message: string; payload: ProfileScorePayload };

/** A re-score is allowed once per 10 minutes (ROUND7-SPEC §4). */
export const RESCORE_COOLDOWN_SEC = 600;
/**
 * Hard ceiling on one model call. Well inside what a browser and Railway's proxy will hold open, so an OpenAI outage
 * comes back as the cached report rather than as a connection the person watches die.
 */
export const SCORE_DEADLINE_MS = 75_000;
/** One run costs one credit on the `ask` metric. */
export const SCORE_COST_CREDITS = 1;

const MANUAL_META_KEY = 'profile_manual';
const BIO_MAX = 150;

/* ------------------------------------------------------------------ */
/* Goals                                                               */
/* ------------------------------------------------------------------ */

const clean = (v: unknown, max = 200): string | null => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

export function getGoals(tid: number): ProfileGoals | null {
  const r = db().prepare('SELECT goal, niche, audience, offer, tone, updated_at FROM profile_goals WHERE tenant_id = ?').get(tid) as
    | { goal: string | null; niche: string | null; audience: string | null; offer: string | null; tone: string | null; updated_at: number }
    | undefined;
  if (!r) return null;
  return { goal: r.goal, niche: r.niche, audience: r.audience, offer: r.offer, tone: r.tone, updatedAt: r.updated_at };
}

/** Upsert the questionnaire answers. Only the fields present in `patch` change; `null` clears one. */
export function saveGoals(tid: number, patch: Partial<Record<GoalField, string | null>>): ProfileGoals {
  const current = getGoals(tid);
  const merged: Record<GoalField, string | null> = {
    goal: current?.goal ?? null, niche: current?.niche ?? null, audience: current?.audience ?? null,
    offer: current?.offer ?? null, tone: current?.tone ?? null,
  };
  for (const f of GOAL_FIELDS) if (f in patch) merged[f] = clean(patch[f]);
  const ts = now();
  db().prepare(`INSERT INTO profile_goals (tenant_id, goal, niche, audience, offer, tone, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET goal = excluded.goal, niche = excluded.niche, audience = excluded.audience, offer = excluded.offer, tone = excluded.tone, updated_at = excluded.updated_at`)
    .run(tid, merged.goal, merged.niche, merged.audience, merged.offer, merged.tone, ts);
  return { ...merged, updatedAt: ts };
}

/* ------------------------------------------------------------------ */
/* The subject: connected account, pasted profile, or both             */
/* ------------------------------------------------------------------ */

export interface ManualProfile { username: string | null; name: string | null; bio: string | null; link: string | null; updatedAt: number }

export function manualProfile(tid: number): ManualProfile | null {
  const raw = getMeta(tid, MANUAL_META_KEY);
  if (!raw) return null;
  const m = j<Partial<ManualProfile> | null>(raw, null);
  if (!m) return null;
  return {
    username: clean(m.username, 40)?.replace(/^@/, '') ?? null,
    name: clean(m.name, 80),
    bio: typeof m.bio === 'string' ? m.bio.slice(0, 400) : null,
    link: clean(m.link, 300),
    updatedAt: Number(m.updatedAt) || 0,
  };
}

/** Store a pasted profile so a re-score and the questionnaire prefill work without asking for it twice. */
export function saveManualProfile(tid: number, patch: { username?: unknown; name?: unknown; bio?: unknown; link?: unknown }): ManualProfile {
  const cur = manualProfile(tid);
  const next: ManualProfile = {
    username: 'username' in patch ? (clean(patch.username, 40)?.replace(/^@/, '') ?? null) : cur?.username ?? null,
    name: 'name' in patch ? clean(patch.name, 80) : cur?.name ?? null,
    // The bio is the thing under review — keep the person's own line breaks and emoji exactly as they typed them.
    bio: 'bio' in patch ? (typeof patch.bio === 'string' && patch.bio.trim() ? patch.bio.replace(/\r\n/g, '\n').slice(0, 400) : null) : cur?.bio ?? null,
    link: 'link' in patch ? clean(patch.link, 300) : cur?.link ?? null,
    updatedAt: now(),
  };
  setMeta(tid, MANUAL_META_KEY, JSON.stringify(next));
  return next;
}

function igAccount(tid: number): { username: string | null; name: string | null; accountType: string | null; photoUrl: string | null; followers: number | null; follows: number | null; mediaCount: number | null } | null {
  try {
    const r = db().prepare('SELECT username, name, account_type, profile_picture_url, followers_count, follows_count, media_count FROM ig_accounts WHERE tenant_id = ?').get(tid) as any;
    if (!r) return null;
    return {
      username: r.username ?? null, name: r.name ?? null, accountType: r.account_type ?? null, photoUrl: r.profile_picture_url ?? null,
      followers: typeof r.followers_count === 'number' ? r.followers_count : null,
      follows: typeof r.follows_count === 'number' ? r.follows_count : null,
      mediaCount: typeof r.media_count === 'number' ? r.media_count : null,
    };
  } catch {
    return null; // migration 004 not applied in this checkout
  }
}

/**
 * What we are actually scoring: the connected account where there is one, the pasted profile otherwise, and the
 * merge of the two when both exist (the paste wins for the fields Instagram never gives us — bio and link).
 */
export function profileSubject(tid: number): ProfileSubject {
  const ig = igAccount(tid);
  const manual = manualProfile(tid);
  const own = ownContentProfile(tid, 12);

  const username = manual?.username || ig?.username || null;
  const name = manual?.name || ig?.name || null;
  const bio = manual?.bio ?? null;   // the Instagram Login API does not return a biography — it can only be pasted
  const link = manual?.link ?? null;
  const followers = ig?.followers ?? own.account.followers ?? null;
  const posts = ig?.mediaCount ?? own.account.mediaCount ?? null;

  const source: SubjectSource = ig && manual ? 'mixed' : ig ? 'instagram' : manual ? 'manual' : 'none';
  const cadence = own.hasPosts
    ? { postsPerWeek: own.averages.postsPerWeek, sampled: own.averages.posts, formats: own.averages.byFormat.map((f) => ({ format: f.format, posts: f.posts })) }
    : null;

  const missing: string[] = [];
  if (!bio) missing.push('the bio text');
  if (!link) missing.push('the link in the bio');
  if (!ig?.photoUrl) missing.push('the profile photo');
  if (!cadence) missing.push('posting cadence and content mix');
  if (followers === null) missing.push('follower count');

  return {
    source, connected: !!ig, manual: source === 'manual', username, name, bio, link,
    accountType: ig?.accountType ?? null, profilePictureUrl: ig?.photoUrl ?? null,
    followers, follows: ig?.follows ?? null, posts,
    cadence, manualUpdatedAt: manual?.updatedAt ?? null, missing,
  };
}

/**
 * Enough to score. The bio is not optional: it is the dimension the overall score leans on hardest, the Instagram
 * Login API never returns it, and the forced schema makes the model emit a bio score whether it saw one or not — so
 * accepting a handle alone produced a report that said "the bio text was not checked" next to a number for the bio.
 * A name on its own is not enough either, which is what the paste form used to claim.
 */
export function canScore(s: ProfileSubject): boolean {
  return !!(s.bio && (s.username || s.name));
}

/** What is still needed before a run can happen — the sentence the paste form shows. */
export function scoreBlocker(s: ProfileSubject): string | null {
  if (!s.username && !s.name) return 'Paste your Instagram handle (or the name on the account) and your bio, and we can score them. Nothing needs to be connected.';
  if (!s.bio) return s.connected
    ? 'Instagram never sends us the bio text, so paste it here once and we can score it. It is remembered for future runs.'
    : 'Paste your bio as well — it is the part the score leans on hardest. It is remembered, so a re-score needs no second paste.';
  return null;
}

/* ------------------------------------------------------------------ */
/* Questionnaire                                                       */
/* ------------------------------------------------------------------ */

const OPTIONS: Record<GoalField, ProfileQuestionOption[]> = {
  goal: [
    { value: 'personal_brand', label: 'A personal brand', hint: 'People follow you, not a company' },
    { value: 'business', label: 'A business', hint: 'The account sells a product or a service' },
    { value: 'creator', label: 'A creator account', hint: 'Reach and brand deals are the point' },
    { value: 'community', label: 'A community', hint: 'A place for a group of people around one topic' },
  ],
  niche: [], // filled from the library at request time
  audience: [
    { value: 'beginners', label: 'Beginners in my topic' },
    { value: 'professionals', label: 'People who already do this for work' },
    { value: 'local', label: 'People near me' },
    { value: 'creators', label: 'Other creators' },
    { value: 'customers', label: 'People who already bought from me' },
  ],
  offer: [
    { value: 'nothing_yet', label: 'Nothing yet — I want an audience first' },
    { value: 'digital_product', label: 'A digital product', hint: 'Course, template, preset, ebook' },
    { value: 'services', label: 'Services', hint: 'Freelance, coaching, consulting' },
    { value: 'physical', label: 'Physical products' },
    { value: 'traffic', label: 'Traffic somewhere else', hint: 'A newsletter, a site, another platform' },
  ],
  tone: [
    { value: 'friendly', label: 'Friendly' },
    { value: 'direct', label: 'Direct' },
    { value: 'playful', label: 'Playful' },
    { value: 'expert', label: 'Expert' },
    { value: 'calm', label: 'Calm' },
  ],
};

const QUESTION_COPY: Record<GoalField, { title: string; help: string; otherLabel: string; placeholder: string }> = {
  goal: { title: 'What is this account for?', help: 'It decides what the bio has to do.', otherLabel: 'Something else', placeholder: 'In a few words' },
  niche: { title: 'What is it about?', help: 'One topic reads better than five.', otherLabel: 'A different topic', placeholder: 'e.g. sourdough baking' },
  audience: { title: 'Who should follow you?', help: 'The bio speaks to one person.', otherLabel: 'Someone else', placeholder: 'Describe them in a few words' },
  offer: { title: 'What do you want people to do?', help: 'This is what the link and the call to action are for.', otherLabel: 'Something else', placeholder: 'e.g. book a table' },
  tone: { title: 'How should it sound?', help: 'The rewrites will be written in this voice.', otherLabel: 'A different tone', placeholder: 'e.g. dry and technical' },
};

/**
 * The two counts this feature needs from the library: what they save most, and what they tag it.
 * `statsSummary()` in ./ask.ts answers the same question and eight others; this stays a pair of queries so the
 * questionnaire (which runs on every visit to the page) does not pay for aggregates nobody reads here.
 */
export interface LibraryThemes { categories: Array<{ name: string; n: number }>; tags: Array<{ name: string; n: number }> }

export function libraryThemes(tid: number): LibraryThemes {
  const base = 'i.tenant_id = ? AND i.archived = 0 AND i.excluded = 0';
  try {
    const d = db();
    const categories = d.prepare(`SELECT json_extract(i.analysis, '$.category') AS name, COUNT(*) AS n FROM items i WHERE ${base} AND i.analysis_status = 'done' AND name IS NOT NULL GROUP BY name ORDER BY n DESC LIMIT 6`).all(tid) as Array<{ name: string; n: number }>;
    const tags = d.prepare(`SELECT t.tag AS name, COUNT(*) AS n FROM item_tags t JOIN items i ON i.id = t.item_id WHERE ${base} GROUP BY t.tag ORDER BY n DESC LIMIT 12`).all(tid) as Array<{ name: string; n: number }>;
    return { categories: categories.filter((c) => c.name), tags: tags.filter((t) => t.name) };
  } catch {
    return { categories: [], tags: [] };
  }
}

/** Words a person would recognise for the source of a suggestion. */
interface Prefill { value: string | null; from: string | null }

function prefills(themes: LibraryThemes, subject: ProfileSubject, ownHashtag: string | null): Record<GoalField, Prefill> {
  const topCategories = themes.categories.slice(0, 5);
  const topTag = themes.tags[0]?.name ?? null;
  const bio = (subject.bio || '').toLowerCase();

  const goal: Prefill = (() => {
    const type = (subject.accountType || '').toUpperCase();
    if (type.includes('BUSINESS')) return { value: 'business', from: 'your Instagram account type' };
    if (type.includes('CREATOR') || type.includes('MEDIA_CREATOR')) return { value: 'creator', from: 'your Instagram account type' };
    if (/\b(shop|store|studio|agency|salon|cafe|bakery)\b/.test(bio)) return { value: 'business', from: 'a word in your bio' };
    return { value: null, from: null };
  })();

  // Their own captions are the last resort: a connected account with nothing analyzed yet still gets a suggestion.
  const niche: Prefill = topCategories.length
    ? { value: topCategories[0].name, from: `the category you save most (${topCategories[0].n} saves)` }
    : topTag
      ? { value: topTag, from: 'your most used tag' }
      : ownHashtag
        ? { value: ownHashtag, from: 'the hashtag you use most in your own captions' }
        : { value: null, from: null };

  // A guess has to read like one: we know the topic they save most, not who follows them.
  const audience: Prefill = topCategories.length
    ? { value: 'beginners', from: `a guess from the topic you save most (${topCategories[0].name})` }
    : { value: null, from: null };

  const offer: Prefill = subject.link
    ? { value: 'traffic', from: 'you already have a link in your bio' }
    : subject.source === 'none'
      ? { value: null, from: null } // nothing pasted and nothing connected — we cannot claim their bio has no link
      : { value: 'nothing_yet', from: 'there is no link in your bio yet' };

  const tone: Prefill = (() => {
    if (!subject.bio) return { value: null, from: null };
    const emoji = /\p{Extended_Pictographic}/u.test(subject.bio);
    if (emoji) return { value: 'playful', from: 'your bio uses emoji' };
    if (subject.bio.length <= 60) return { value: 'direct', from: 'your bio is short and plain' };
    return { value: 'friendly', from: 'the way your bio is written' };
  })();

  return { goal, niche, audience, offer, tone };
}

/**
 * The five questions, every one prefilled from what we already know, so the person confirms rather than composes.
 * `niche` gets its options from their own saved categories — a list they will recognise.
 */
export function profileQuestions(tid: number): { questions: ProfileQuestion[]; goals: ProfileGoals | null; subject: ProfileSubject; connected: boolean } {
  const subject = profileSubject(tid);
  const goals = getGoals(tid);
  const themes = libraryThemes(tid);
  const pre = prefills(themes, subject, ownContentProfile(tid, 12).hashtags[0]?.tag ?? null);
  const nicheOptions: ProfileQuestionOption[] = themes.categories
    .slice(0, 5)
    .map((c) => ({ value: c.name, label: c.name, hint: `${c.n} save${c.n === 1 ? '' : 's'}` }));

  const questions: ProfileQuestion[] = GOAL_FIELDS.map((id) => ({
    id,
    ...QUESTION_COPY[id],
    allowOther: true,
    options: id === 'niche' ? nicheOptions : OPTIONS[id],
    prefill: pre[id].value,
    prefillFrom: pre[id].from,
    answer: goals ? goals[id] : null,
  }));
  return { questions, goals, subject, connected: subject.connected };
}

/** The label behind an option value, for the prompt (the model should read "A business", not "business"). */
function goalLabel(field: GoalField, value: string | null): string | null {
  if (!value) return null;
  const opt = OPTIONS[field].find((o) => o.value === value);
  return opt ? opt.label : value;
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

function rowToScore(r: { id: number; created_at: number; overall: number; json: string } | undefined): ScoreRow | null {
  if (!r) return null;
  const report = j<ProfileReport | null>(r.json, null);
  if (!report) return null;
  return { id: r.id, createdAt: r.created_at, overall: r.overall, report };
}

export function latestScore(tid: number): ScoreRow | null {
  return rowToScore(db().prepare('SELECT id, created_at, overall, json FROM profile_scores WHERE tenant_id = ? ORDER BY id DESC LIMIT 1').get(tid) as any);
}

/** The two newest rows: the current report and the one it should be compared against. */
function twoNewest(tid: number): Array<{ id: number; created_at: number; overall: number; json: string }> {
  return db().prepare('SELECT id, created_at, overall, json FROM profile_scores WHERE tenant_id = ? ORDER BY id DESC LIMIT 2').all(tid) as any[];
}

function insertScore(tid: number, report: ProfileReport): ScoreRow {
  const ts = report.generatedAt;
  const id = Number(db().prepare('INSERT INTO profile_scores (tenant_id, created_at, overall, json) VALUES (?, ?, ?, ?)').run(tid, ts, report.overall, JSON.stringify(report)).lastInsertRowid);
  return { id, createdAt: ts, overall: report.overall, report };
}

/** Seconds left on the 10-minute re-score cooldown (0 when a run is allowed). */
export function cooldownSeconds(tid: number): number {
  const last = db().prepare('SELECT created_at FROM profile_scores WHERE tenant_id = ? ORDER BY id DESC LIMIT 1').get(tid) as { created_at: number } | undefined;
  if (!last) return 0;
  return Math.max(0, last.created_at + RESCORE_COOLDOWN_SEC - now());
}

/** The payload every endpoint returns, so the page always has the whole picture. */
export function scorePayload(tid: number, over: Partial<ProfileScorePayload> = {}): ProfileScorePayload {
  const rows = twoNewest(tid);
  const score = rowToScore(rows[0]);
  const prevRow = rows[1];
  const previous = prevRow ? { id: prevRow.id, createdAt: prevRow.created_at, overall: prevRow.overall } : null;
  const subject = over.subject ?? profileSubject(tid);
  const cool = cooldownSeconds(tid);
  return {
    score,
    previous,
    delta: score && previous ? score.overall - previous.overall : null,
    stale: false,
    staleReason: null,
    goals: getGoals(tid),
    subject,
    connected: subject.connected,
    canScore: canScore(subject),
    cooldownSeconds: cool,
    retryAt: cool > 0 ? now() + cool : null,
    cost: { credits: SCORE_COST_CREDITS, metric: 'ask' },
    charged: null,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

const SYSTEM = `You audit Instagram profiles. You are a working social-media strategist: specific, calm, and useful. No hype, no filler, no emoji unless the person's own bio uses them.

You are given a profile exactly as it is written, the goals the person stated for the account, and — only when we have them — measured facts about what they post and what they save.

Rules you cannot break:
- Never invent a number. Use only figures that appear in the input. If a fact is listed as not available, say it is not visible rather than guessing, and never score as if you had measured it.
- Never tell the person to connect Instagram, install anything, or use another product. Every fix is something they can do inside the Instagram app or on instagram.com today.
- Name the exact field or setting a fix touches ("the Name field", "the bio's third line", "Edit profile > Contact options").
- effort: "minute" = a change they can make right now in Edit profile; "hour" = needs writing or a new photo; "project" = a week of work.
- Judge against the stated goal, niche and audience. A bio that is fine in general but wrong for their goal scores low.

Scoring, so the number means the same thing next week:
- 0-39: missing, confusing, or working against the stated goal.
- 40-59: present but generic — it would fit a thousand accounts.
- 60-79: clear, with one obvious gap.
- 80-100: specific, searchable, and matched to the stated goal. Reserve 90+ for a profile you would show as an example.
- overall is your judgement of the profile as a whole, not an average — weight bio and positioning most.

The five dimensions:
- name_handle: the Name field (Instagram searches it, so it should carry the topic) and the @handle — readable, spellable, sayable out loud.
- bio: the 150 characters — who it is for, what they get, what to do next.
- photo: how the picture reads at 40 pixels wide — face or mark, contrast, crop. If the photo was not supplied, score what the handle and name imply and say plainly that you could not see the picture.
- positioning: does the whole profile say one thing, and is that thing the stated goal?
- settings: professional account type, the category shown, contact buttons, the link (or link list), story highlights, and the message/comment settings the stated goal needs. When you cannot verify a setting, phrase the fix as something to check.

bio_rewrites: three complete, paste-ready bios, at most 150 characters each including line breaks, in their voice and their language. Each one takes a different angle (for example: what they do for whom, a specific proof, a clear call to action). Never use "link in bio" as filler, never open with an emoji unless their current bio does.

next_three: the three highest-impact actions in order, drawn from the fixes above. First one should be doable in a minute where possible.`;

const fixSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    what: { type: 'string', description: 'The change, imperative, one sentence, max ~140 chars. Name the exact field.' },
    why: { type: 'string', description: 'One sentence on what it changes for their stated goal. Max ~140 chars.' },
    effort: { type: 'string', enum: ['minute', 'hour', 'project'] },
    example: { type: ['string', 'null'], description: 'Paste-ready text for this change when that helps (a name line, a bio line, a highlight title). Null when an example makes no sense.' },
  },
  required: ['what', 'why', 'effort', 'example'],
} as const;

const dimensionSchema = (what: string) => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100, description: `0-100 for ${what}.` },
    verdict: { type: 'string', description: 'One line, max ~120 chars, written to the person. No preamble.' },
    fixes: { type: 'array', description: '1 to 3 fixes, most important first.', items: fixSchema },
  },
  required: ['score', 'verdict', 'fixes'],
});

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    overall: { type: 'integer', minimum: 0, maximum: 100, description: 'The profile as a whole, 0-100.' },
    headline: { type: 'string', description: 'One sentence, max ~140 chars: what this profile is doing well and what is holding it back.' },
    name_handle: dimensionSchema('the Name field and the @handle'),
    bio: dimensionSchema('the bio text'),
    photo: dimensionSchema('the profile photo'),
    positioning: dimensionSchema('whether the profile says one clear thing that matches the goal'),
    settings: dimensionSchema('account type, category, contact buttons, link, highlights and message settings'),
    bio_rewrites: {
      type: 'array',
      description: 'Exactly three paste-ready bios, each at most 150 characters.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: 'The complete bio, at most 150 characters including line breaks.' },
          angle: { type: 'string', description: 'Two to four words naming the angle, e.g. "proof first", "clear call to action".' },
        },
        required: ['text', 'angle'],
      },
    },
    next_three: { type: 'array', description: 'Exactly three actions, highest impact first.', items: fixSchema },
  },
  required: ['overall', 'headline', 'name_handle', 'bio', 'photo', 'positioning', 'settings', 'bio_rewrites', 'next_three'],
} as const;

interface RawDimension { score?: unknown; verdict?: unknown; fixes?: unknown }
interface RawReport {
  overall?: unknown; headline?: unknown;
  name_handle?: RawDimension; bio?: RawDimension; photo?: RawDimension; positioning?: RawDimension; settings?: RawDimension;
  bio_rewrites?: unknown; next_three?: unknown;
}

function buildUserMessage(subject: ProfileSubject, goals: ProfileGoals | null, tid: number): string {
  const L: string[] = [];
  const src = subject.source === 'instagram' ? 'read from their connected Instagram account'
    : subject.source === 'manual' ? 'pasted by the person (their Instagram account is not connected)'
      : subject.source === 'mixed' ? 'partly from their connected Instagram account, partly pasted by them'
        : 'not available';

  L.push(`PROFILE (${src})`);
  L.push(`- handle: ${subject.username ? `@${subject.username}` : 'not available'}`);
  L.push(`- Name field: ${subject.name ? `"${subject.name}"` : 'not available'}`);
  L.push(`- bio, verbatim:\n${subject.bio ? subject.bio.split('\n').map((l) => `  | ${l}`).join('\n') : '  | (not available)'}`);
  L.push(`- link in bio: ${subject.link || 'none'}`);
  L.push(`- account type: ${subject.accountType || 'not available'}`);
  L.push(`- profile photo: ${subject.profilePictureUrl ? 'set (you cannot see it — judge only what the handle and name imply, and say so)' : 'not available'}`);
  L.push(`- followers: ${subject.followers ?? 'not available'}${subject.follows !== null ? ` · following: ${subject.follows}` : ''}`);
  L.push(`- posts published: ${subject.posts ?? 'not available'}`);

  if (subject.cadence) {
    const c = subject.cadence;
    L.push('', 'WHAT THEY POST (measured from their own last posts — use these numbers exactly, do not extrapolate)');
    L.push(`- ${c.sampled} recent posts${c.postsPerWeek !== null ? `, about ${c.postsPerWeek} a week` : ''}`);
    if (c.formats.length) L.push(`- mix: ${c.formats.map((f) => `${f.format} ${f.posts}`).join(', ')}`);
    const gists = ownContentProfile(tid, 12).posts.map((p) => p.gist).filter(Boolean).slice(0, 8);
    if (gists.length) L.push(`- recent captions, gist only: ${gists.map((g) => `"${g}"`).join('; ')}`);
  } else {
    L.push('', 'WHAT THEY POST: not available. Do not comment on posting frequency, formats or performance.');
  }

  const themes = libraryThemes(tid);
  const cats = themes.categories.slice(0, 6);
  const tags = themes.tags.slice(0, 12);
  if (cats.length || tags.length) {
    L.push('', 'WHAT THEY SAVE (their own library in this product — a fair signal of what they care about)');
    if (cats.length) L.push(`- top categories: ${cats.map((c) => `${c.name} ${c.n}`).join(', ')}`);
    if (tags.length) L.push(`- top tags: ${tags.map((t) => t.name).join(', ')}`);
  }

  L.push('', 'THEIR GOALS FOR THE ACCOUNT');
  if (goals && GOAL_FIELDS.some((f) => goals[f])) {
    const line = (f: GoalField, label: string) => L.push(`- ${label}: ${goalLabel(f, goals[f]) || 'not answered'}`);
    line('goal', 'the account is');
    line('niche', 'topic');
    line('audience', 'who should follow');
    line('offer', 'what people should do');
    line('tone', 'tone of voice');
  } else {
    L.push('- not answered. Score against the most plausible goal you can read out of the bio, and say which goal you assumed.');
  }

  if (subject.missing.length) {
    L.push('', `NOT AVAILABLE, do not pretend otherwise: ${subject.missing.join('; ')}.`);
  }
  return L.join('\n');
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

const clampScore = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
};
const text = (v: unknown, max: number): string => String(v ?? '').replace(/\s+$/g, '').slice(0, max);

const EFFORTS: FixEffort[] = ['minute', 'hour', 'project'];
function normalizeFix(raw: unknown): ProfileFix | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const what = text(r.what, 200).trim();
  if (!what) return null;
  const effort = EFFORTS.includes(r.effort as FixEffort) ? (r.effort as FixEffort) : 'hour';
  const example = typeof r.example === 'string' && r.example.trim() ? r.example.slice(0, 300) : null;
  return { what, why: text(r.why, 200).trim(), effort, example };
}

function normalizeDimension(raw: RawDimension | undefined): ProfileDimension {
  const fixes = (Array.isArray(raw?.fixes) ? raw!.fixes : []).map(normalizeFix).filter((f): f is ProfileFix => !!f).slice(0, 3);
  return { score: clampScore(raw?.score), verdict: text(raw?.verdict, 200).trim(), fixes };
}

/**
 * Trim to Instagram's 150-character bio limit at a word boundary rather than mid-word.
 * Counted in code points, not UTF-16 units — a bio written in emoji would otherwise lose half its characters.
 */
function fitBio(s: string): string {
  const t = s.replace(/\r\n/g, '\n').trim();
  const chars = [...t];
  if (chars.length <= BIO_MAX) return t;
  const cut = chars.slice(0, BIO_MAX).join('');
  const lastBreak = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  const atBreak = lastBreak > 0 ? cut.slice(0, lastBreak) : '';
  // Break on a word when that keeps most of the line. When it does not — one very long token, a URL — a hard slice
  // would hand the person a bio ending mid-word and label it paste-ready, so drop the unfinished token and mark it.
  if ([...atBreak].length >= BIO_MAX - 30) return atBreak.trimEnd();
  if (atBreak.trim()) return `${atBreak.trimEnd()}…`;
  return cut.trimEnd();
}

/**
 * Did the model actually return a report? `strict: true` makes this unlikely against the real API, but
 * `OPENAI_BASE_URL` can point the key at a gateway that ignores `json_schema`, and the failure mode without this
 * check is silent: `{}` normalises into a complete 0/100 report, gets stored, charged, and becomes the baseline the
 * next run's delta is measured against.
 */
function looksLikeReport(raw: RawReport | null | undefined): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const hasOverall = Number.isFinite(Number((raw as any).overall));
  const hasDimension = PROFILE_DIMENSIONS.some((k) => {
    const d = (raw as any)[k];
    return !!d && typeof d === 'object' && (Number.isFinite(Number(d.score)) || typeof d.verdict === 'string');
  });
  return hasOverall && hasDimension;
}

/** Reject a promise that outruns `ms`. The underlying call is abandoned, not awaited. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the scoring run took longer than ${Math.round(ms / 1000)}s`)), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer!)) as Promise<T>;
}

function normalizeReport(raw: RawReport, ctx: { subject: ProfileSubject; goals: ProfileGoals | null; model: string }): ProfileReport {
  const dimensions = {
    name_handle: normalizeDimension(raw.name_handle),
    bio: normalizeDimension(raw.bio),
    photo: normalizeDimension(raw.photo),
    positioning: normalizeDimension(raw.positioning),
    settings: normalizeDimension(raw.settings),
  };
  const rewrites = (Array.isArray(raw.bio_rewrites) ? raw.bio_rewrites : [])
    .map((r): BioRewrite | null => {
      if (!r || typeof r !== 'object') return null;
      const t = fitBio(String((r as any).text ?? ''));
      if (!t) return null;
      return { text: t, angle: text((r as any).angle, 40).trim(), length: [...t].length };
    })
    .filter((r): r is BioRewrite => !!r)
    .slice(0, 3);
  const nextThree = (Array.isArray(raw.next_three) ? raw.next_three : []).map(normalizeFix).filter((f): f is ProfileFix => !!f).slice(0, 3);

  return {
    overall: clampScore(raw.overall),
    headline: text(raw.headline, 240).trim(),
    dimensions,
    bioRewrites: rewrites,
    nextThree,
    notChecked: ctx.subject.missing.slice(),
    subject: {
      source: ctx.subject.source, username: ctx.subject.username, name: ctx.subject.name,
      bio: ctx.subject.bio, link: ctx.subject.link, followers: ctx.subject.followers, posts: ctx.subject.posts,
    },
    goals: {
      goal: ctx.goals?.goal ?? null, niche: ctx.goals?.niche ?? null, audience: ctx.goals?.audience ?? null,
      offer: ctx.goals?.offer ?? null, tone: ctx.goals?.tone ?? null,
    },
    model: ctx.model,
    generatedAt: now(),
  };
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

export interface RunOptions {
  /** A pasted profile — the path for everyone who cannot connect Instagram. Stored, so a re-score needs no paste. */
  manual?: { username?: unknown; name?: unknown; bio?: unknown; link?: unknown } | null;
  /** Questionnaire answers submitted together with the run (the five-tap flow ends on "Score it"). */
  goals?: Partial<Record<GoalField, string | null>> | null;
  /** Skip the 10-minute cooldown. Only internal callers and tests pass this — the HTTP route never does. */
  ignoreCooldown?: boolean;
}

/**
 * Run one scoring pass. The credit is charged only after the model has answered, so a failure costs nothing;
 * an OpenAI outage returns the previous report marked `stale` instead of an error.
 */
export async function runProfileScore(tid: number, opts: RunOptions = {}): Promise<ScoreOutcome> {
  if (opts.manual && Object.keys(opts.manual).length) saveManualProfile(tid, opts.manual);
  if (opts.goals && Object.keys(opts.goals).length) saveGoals(tid, opts.goals);

  const subject = profileSubject(tid);
  if (!canScore(subject)) {
    return {
      status: 'needs_profile',
      message: scoreBlocker(subject) || 'Paste your Instagram handle and bio and we can score them. Nothing needs to be connected.',
      payload: scorePayload(tid, { subject }),
    };
  }

  const cool = opts.ignoreCooldown ? 0 : cooldownSeconds(tid);
  if (cool > 0) {
    const mins = Math.ceil(cool / 60);
    return {
      status: 'rate_limited',
      retryAfter: cool,
      message: `You scored this profile a few minutes ago. The next score is available in ${mins} minute${mins === 1 ? '' : 's'}.`,
      payload: scorePayload(tid, { subject }),
    };
  }

  // The cooldown reads the newest stored row, which is only written ~15 seconds later — so it is not a concurrency
  // guard. Two tabs, a phone and a desktop, or a double tap that beats the React re-render all used to produce two
  // model calls, two credits and a "delta" between two reports of the same profile. This is the guard.
  if (inFlight.has(tid)) {
    return {
      status: 'rate_limited',
      retryAfter: 20,
      message: 'A score is already running for this account. It will appear here in a moment.',
      payload: scorePayload(tid, { subject }),
    };
  }
  inFlight.add(tid);
  try {
    return await runScoreLocked(tid, subject);
  } finally {
    inFlight.delete(tid);
  }
}

/** One tenant, one run at a time — see the guard in `runProfileScore`. */
const inFlight = new Set<number>();

async function runScoreLocked(tid: number, subject: ProfileSubject): Promise<ScoreOutcome> {
  const goals = getGoals(tid);
  const stale = (reason: string): ScoreOutcome => {
    const cached = latestScore(tid);
    if (cached) return { status: 'stale', message: reason, payload: scorePayload(tid, { subject, stale: true, staleReason: reason }) };
    return { status: 'unavailable', message: reason, payload: scorePayload(tid, { subject }) };
  };

  if (!hasOpenAI(tid)) return stale('Scoring is unavailable right now — the assistant is not configured on our side. Nothing was charged.');
  // The breaker the last round added for exactly this: while OpenAI is known to be refusing on billing, do not pay
  // for another full round trip before answering with the cached report.
  if (quotaBlocked()) return stale('Scoring is briefly unavailable on our side. Nothing was charged to you — try again in a few minutes.');

  const model = models(tid).ask;
  let raw: RawReport;
  try {
    // The OpenAI client retries four times with a three-minute timeout each, so "OpenAI down" could mean fifteen
    // minutes of waiting — long past the point where Railway's proxy and the browser have given up, which turns the
    // documented "cached report, never a 500" into a dead connection. Bound the whole call ourselves.
    const res = await withDeadline(
      generateStructured<RawReport>({
        tid,
        model,
        system: SYSTEM,
        user: buildUserMessage(subject, goals, tid),
        schemaName: 'instagram_profile_score',
        schema: REPORT_SCHEMA as unknown as Record<string, unknown>,
        maxOutputTokens: 3500,
        effort: 'low',
      }),
      SCORE_DEADLINE_MS,
    );
    raw = res.data;
    // A body that parses but carries no report is not a report: clampScore turns every missing field into 0, so this
    // used to be stored as a real 0/100 (charged, and the baseline the next run's delta is measured against).
    if (!looksLikeReport(raw)) throw new Error('the model returned no usable report');
  } catch (e) {
    // An OpenAI billing failure is ours, not the customer's — say so plainly and hand back the last report.
    if (isQuotaError(e)) { noteQuotaFailure(e); console.error('[profile-score] OpenAI quota/billing error:', (e as any)?.message || e); }
    else console.error('[profile-score] model call failed:', (e as any)?.message || e);
    return stale(isQuotaError(e)
      ? 'Scoring is briefly unavailable on our side. Nothing was charged to you — try again in a few minutes.'
      : 'The scoring run did not finish. Nothing was charged to you — try again in a few minutes.');
  }

  const report = normalizeReport(raw, { subject, goals, model });
  const row = insertScore(tid, report);
  const charge = chargeMetered(tid, 'ask', SCORE_COST_CREDITS, `profile-score:${row.id}`);
  // `ok: false` means the allowance and the balance both came up short between the check at the route and now (a
  // concurrent Ask spending the last credit). The report is already written, so it ships — but the page is told the
  // truth about the balance rather than being handed a "Scored." toast over a charge that never happened.
  if (!charge.ok) console.warn(`[profile-score] tenant ${tid}: report ${row.id} delivered but not charged (balance ${charge.balance})`);
  return {
    status: 'ok',
    payload: scorePayload(tid, { subject, charged: { creditsSpent: charge.creditsSpent, balance: charge.balance, ok: charge.ok } }),
  };
}
