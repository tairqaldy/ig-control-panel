/**
 * Can this person connect an Instagram account *right now*? (ROUND7-SPEC §3)
 *
 * The product must never advise something the person cannot do. Our Meta app is in Development mode, so for most
 * people "Connect Instagram" is a button that fails — the onboarding, the Automations and Analytics pages and every
 * AI prompt read this module instead of assuming a connection is one click away.
 *
 * How the verdict is reached:
 *  - no `META_APP_ID` / `META_APP_SECRET` → `unconfigured`: there is no app to connect to.
 *  - a daily probe of `GET /{app-id}` with the app token confirms the credentials still work. Meta does not expose a
 *    "Live mode" flag on the app node, so the probe cannot answer live-vs-development on its own; what it *can* do is
 *    catch the case where our credentials stopped working, which also makes connecting impossible. The live verdict
 *    therefore comes from `META_APP_LIVE` (set it to `true` the moment the app is published) and defaults to
 *    `development` — the state that cannot promise a working connection.
 *  - a tenant that is already connected, a self-hosted deployment (the operator runs their own app and is its
 *    developer) and the owner tenant of a hosted deployment (it owns the Meta app, so it holds a tester role) can
 *    connect even while the app is in Development mode.
 *  - credentials Meta refuses stop everyone from connecting, and read as `unconfigured` only when self-hosted, where
 *    "set up your own Meta app" is the right next step; on a hosted deployment it is ours to fix, not theirs.
 *
 * Per-tenant answers are cached 10 minutes; the app probe is cached 24 hours and shared by every tenant.
 */
import { config } from '../config.js';
import { db, now, OWNER_TENANT } from '../db.js';
import { getAccountRow, instagramConfigured } from './instagram.js';

export type IgMode = 'live' | 'development' | 'unconfigured';

export interface IgAvailability {
  /** true = the Connect button will actually work for this person. */
  canConnect: boolean;
  mode: IgMode;
  /** One sentence a non-developer understands. Safe to render as-is. */
  reason: string;
  /** This tenant already asked to be told when connecting opens. */
  waitlist: boolean;
  /** Whether offering "tell me when it's ready" makes sense (nothing to wait for once it works). */
  waitlistOffered: boolean;
  waitlistEmail: string | null;
  connected: boolean;
  /** Handle of the connected account, when there is one. */
  username: string | null;
  configured: boolean;
  /** The capability line injected into every Ask system prompt. */
  note: string;
  checkedAt: number;
  /** App name from the last successful probe; null until it has run. */
  appName: string | null;
}

export interface WaitlistRow {
  tenant_id: number;
  email: string | null;
  source: string | null;
  created_at: number;
  updated_at: number;
  notified_at: number | null;
}

const TENANT_TTL_MS = 10 * 60_000;
const APP_PROBE_TTL_MS = 24 * 3600_000;
/** A refusal or a failed probe is retried far sooner than a healthy one — it is the answer that closes the door. */
const REJECTED_PROBE_TTL_MS = 15 * 60_000;
/** A forced refresh still may not hit Meta more often than this — `?refresh=1` is reachable by any signed-in person. */
const FORCE_FLOOR_MS = 60_000;
const PROBE_TIMEOUT_MS = 6000;
const CACHE_MAX = 500;

/** Per-tenant answers (10 min). Cleared for one tenant whenever their waitlist row changes. */
const cache = new Map<number, { at: number; value: IgAvailability }>();

/* ------------------------------------------------------------------ */
/* The daily app probe                                                  */
/* ------------------------------------------------------------------ */

/** `ok` = credentials work · `rejected` = Meta refused them · `unreachable` = network/timeout, verdict unchanged. */
interface AppProbe { at: number; status: 'ok' | 'rejected' | 'unreachable'; name: string | null; error: string | null }

let appProbe: AppProbe | null = null;
let probing: Promise<AppProbe> | null = null;

/**
 * Tri-state on purpose: unset means "we do not know", which `config.ts`'s boolean parser cannot express, and
 * "we do not know" must not read as "the app is live".
 */
function envLive(): boolean | null {
  const v = (process.env.META_APP_LIVE || '').trim().toLowerCase();
  if (!v) return null;
  if (['1', 'true', 'yes', 'on', 'live'].includes(v)) return true;
  if (['0', 'false', 'no', 'off', 'development', 'dev'].includes(v)) return false;
  return null;
}

/** The app secret must never reach a client or a log line, not even inside Meta's own error text. */
function redact(s: string): string {
  const secret = config.metaAppSecret;
  return secret ? s.split(secret).join('…') : s;
}

/**
 * Meta error codes that mean "try again", not "your app is wrong": 1 unknown, 2 service temporarily unavailable,
 * 4/17/32/613 rate limits, 341 application limit reached. Plus anything served with a 5xx.
 */
const TRANSIENT_META_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);
function transientMetaError(e: any, status: number): boolean {
  if (status >= 500) return true;
  const code = Number(e?.code);
  return Number.isFinite(code) && TRANSIENT_META_CODES.has(code);
}

async function runProbe(): Promise<AppProbe> {
  const at = Date.now();
  try {
    const url = new URL(`https://graph.facebook.com/${config.graphApiVersion}/${config.metaAppId}`);
    url.searchParams.set('fields', 'id,name,link,category'); // documented Application fields; an unknown one fails the whole call
    url.searchParams.set('access_token', `${config.metaAppId}|${config.metaAppSecret}`);
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (data && typeof data === 'object' && data.error) {
      const e = data.error;
      const message = redact(String(e.message || `Meta answered HTTP ${res.status}`));
      // Not every `error` body means Meta refuses our credentials. A rate limit or a Graph hiccup used to be recorded
      // as `rejected`, which forces canConnect false for every tenant and — because the probe TTL ignores status —
      // stays that way for a full day on a Live, working app, recoverable only by restarting the server. Transient
      // codes are 'unreachable', which leaves the previous verdict alone and is retried within the hour.
      if (transientMetaError(e, res.status)) return { at, status: 'unreachable', name: null, error: message };
      return { at, status: 'rejected', name: null, error: message };
    }
    if (!res.ok || !data) return { at, status: 'unreachable', name: null, error: `Meta answered HTTP ${res.status}` };
    return { at, status: 'ok', name: typeof data.name === 'string' ? data.name : null, error: null };
  } catch (e: any) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { at, status: 'unreachable', name: null, error: timedOut ? 'Meta did not answer in time.' : redact(`Could not reach Meta: ${e?.message || e}`) };
  }
}

/**
 * How long a probe result may stand before we ask Meta again. A healthy answer lasts the day the spec asks for; a
 * refusal is re-checked every fifteen minutes, because that verdict closes the Connect path for everybody and would
 * otherwise survive the app going Live, credentials being fixed, or a rate limit passing.
 */
function probeTtl(p: AppProbe | null): number {
  if (!p) return 0;
  return p.status === 'ok' ? APP_PROBE_TTL_MS : REJECTED_PROBE_TTL_MS;
}

function probeStale(): boolean {
  return !appProbe || Date.now() - appProbe.at > probeTtl(appProbe);
}

/** Refresh the shared probe, at most one call in flight. `force` still respects the one-minute floor. */
async function refreshAppProbe(force = false): Promise<void> {
  if (!instagramConfigured()) return;
  const age = appProbe ? Date.now() - appProbe.at : Infinity;
  if (age < (force ? FORCE_FLOOR_MS : probeTtl(appProbe))) return;
  if (!probing) probing = runProbe().then((p) => { appProbe = p; probing = null; return p; }).catch(() => { probing = null; return { at: Date.now(), status: 'unreachable' as const, name: null, error: null }; });
  await probing;
}

/* ------------------------------------------------------------------ */
/* Waitlist                                                             */
/* ------------------------------------------------------------------ */

/** Reads tolerate a missing table so availability keeps answering if migration 011 has not run yet. */
export function waitlistRow(tid: number): WaitlistRow | null {
  try {
    return (db().prepare('SELECT * FROM ig_waitlist WHERE tenant_id = ?').get(tid) as WaitlistRow | undefined) ?? null;
  } catch { return null; }
}

/** One row per tenant: asking twice updates the e-mail instead of adding a second row. */
export function waitlistAdd(tid: number, email: string | null, source: string | null = null): { row: WaitlistRow; alreadyOn: boolean } {
  const existing = waitlistRow(tid);
  const t = now();
  db().prepare(`INSERT INTO ig_waitlist (tenant_id, email, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET email = COALESCE(excluded.email, ig_waitlist.email), source = COALESCE(excluded.source, ig_waitlist.source), updated_at = excluded.updated_at`)
    .run(tid, email, source, t, t);
  cache.delete(tid); // the next availability read must show them on the list
  return { row: waitlistRow(tid) ?? { tenant_id: tid, email, source, created_at: t, updated_at: t, notified_at: null }, alreadyOn: !!existing };
}

export function waitlistRemove(tid: number): boolean {
  let changed = 0;
  try { changed = db().prepare('DELETE FROM ig_waitlist WHERE tenant_id = ?').run(tid).changes; } catch { changed = 0; }
  cache.delete(tid);
  return changed > 0;
}

/** Everyone waiting, oldest first — for the e-mail that goes out when connecting opens. */
export function waitlistAll(limit = 1000): WaitlistRow[] {
  try {
    return db().prepare('SELECT * FROM ig_waitlist WHERE notified_at IS NULL ORDER BY created_at ASC LIMIT ?').all(limit) as WaitlistRow[];
  } catch { return []; }
}

/* ------------------------------------------------------------------ */
/* The verdict                                                          */
/* ------------------------------------------------------------------ */

/** The connected account, or null. Tolerates a missing `ig_accounts` table (migration 004 absent). */
function account(tid: number) {
  try { return getAccountRow(tid) ?? null; } catch { return null; }
}

function noteFor(a: { canConnect: boolean; connected: boolean; reason: string }): string {
  if (a.connected) return `Capability: this person's Instagram account is connected, so their own posts and numbers reach you in the context when they exist. Never tell them to connect Instagram.`;
  if (!a.canConnect) return `Capability: this person cannot connect an Instagram account right now. ${a.reason} Never tell them to connect Instagram, to open Automations to connect, or to wait for their own analytics. Answer with what their library of saves already supports, and say plainly that the account side is unavailable if they ask about it.`;
  return `Capability: this person has not connected their Instagram account yet, though they can, from Automations. Bring it up only when it is the actual answer to what they asked.`;
}

function assemble(tid: number): IgAvailability {
  const configured = instagramConfigured();
  const rejected = configured && appProbe?.status === 'rejected';
  const row = account(tid);
  const connected = !!row;
  const username = row?.username || 'your account';
  const wl = waitlistRow(tid);
  const live = envLive();

  // A refused probe is NOT allowed to close the Connect path, and this is not caution — it is the configuration we
  // actually run. `META_APP_ID` here is an *Instagram* app id (Instagram API with Instagram Login), and
  // `graph.facebook.com/{id}` only resolves a Facebook **Application** node, so Meta refuses the lookup for every
  // correctly configured Instagram-Login deployment. Reading that as "our credentials are rejected" set
  // canConnect=false for everyone — including the owner, who demonstrably can connect — and put "Meta is not accepting
  // our app's credentials" on the site and into every Ask prompt. The probe can confirm reachability and a name; it
  // cannot judge our credentials, and it never could answer live-vs-development (see the header). `META_APP_LIVE` is
  // the authority on that, so a refusal is now only a diagnostic for whoever holds the credentials.
  const usable = configured;
  const mode: IgMode = !configured
    ? 'unconfigured'
    : live === true ? 'live' : 'development';
  // A self-hoster runs their own Meta app and is its developer; the owner tenant of a hosted deployment owns the app we run.
  const tester = !config.hosted || tid === OWNER_TENANT;
  const canConnect = usable && (mode === 'live' || connected || tester);

  let reason: string;
  if (!configured) {
    reason = 'This server has no Meta app configured, so Instagram cannot be connected here.';
  } else if (mode === 'live') {
    reason = connected ? `Instagram is connected as @${username}.` : 'You can connect an Instagram account.';
  } else if (connected) {
    reason = `Instagram is connected as @${username}. Our Meta app is still in Development mode, so only accounts with a tester role on it receive DMs and comments.`;
  } else if (tester) {
    reason = 'Our Meta app is in Development mode. Accounts with a tester or admin role on it can connect; everyone else waits until Meta publishes it.';
  } else {
    reason = "Connecting Instagram accounts is waiting on Meta's review of our app. Everything else works without it, and we'll e-mail you the moment it opens.";
  }
  // The probe's refusal is still worth knowing — but only to whoever can act on it, and only as an aside. Meta's own
  // error text never reaches a customer, and it is expected to be present on an Instagram-Login app (see above), so it
  // is phrased as something to check rather than something that is broken.
  if (rejected && tester) {
    reason += ` (Our daily check of the Meta app did not get an answer it could read${appProbe?.error ? `: ${appProbe.error}` : ''}. That is normal for an Instagram-Login app and does not block connecting; set META_APP_LIVE=true once the app is published.)`;
  }

  const base = { canConnect, connected, reason };
  return {
    canConnect,
    mode,
    reason,
    waitlist: !!wl,
    // Nothing to promise a self-hoster whose own server has no working Meta app — they are the one who would fix it.
    waitlistOffered: !canConnect && !connected && mode !== 'unconfigured',
    waitlistEmail: wl?.email ?? null,
    connected,
    username: row?.username ?? null,
    configured,
    note: noteFor(base),
    checkedAt: now(),
    appName: appProbe?.name ?? null,
  };
}

/** The payload behind `GET /api/instagram/availability`. Talks to Meta at most once a day. */
export async function igAvailability(tid: number, opts: { force?: boolean } = {}): Promise<IgAvailability> {
  const hit = opts.force ? undefined : cache.get(tid);
  if (hit && Date.now() - hit.at < TENANT_TTL_MS) return hit.value;
  await refreshAppProbe(opts.force);
  const value = assemble(tid);
  if (cache.size > CACHE_MAX) cache.clear();
  cache.set(tid, { at: Date.now(), value });
  return value;
}

/**
 * The same answer without waiting for Meta: cached value, else assembled from what we already know, with a probe
 * kicked off in the background. Used on paths that must not add a network round-trip (Ask prompt assembly).
 */
export function igAvailabilityCached(tid: number): IgAvailability {
  const hit = cache.get(tid);
  if (hit && Date.now() - hit.at < TENANT_TTL_MS) return hit.value;
  if (probeStale()) void refreshAppProbe();
  const value = assemble(tid);
  if (cache.size > CACHE_MAX) cache.clear();
  cache.set(tid, { at: Date.now(), value });
  return value;
}

/**
 * One line for the AI system prompts. The father's session ended with the assistant repeatedly recommending the one
 * thing he could not do; this sentence is what makes that structurally impossible. Never throws — a broken lookup
 * must not take Ask down with it.
 */
export function igCapabilityNote(tid: number): string {
  try { return igAvailabilityCached(tid).note; } catch { return ''; }
}

/**
 * Forget what we answered for one tenant. Called the moment a connection appears or disappears (OAuth callback,
 * Disconnect in Settings, Meta's deauthorize and data-deletion callbacks): the 10-minute cache is also what feeds the
 * AI capability note, so without this the assistant spends ten minutes telling somebody who just connected to go and
 * connect — or telling somebody who just disconnected that their own numbers are available.
 */
export function invalidateIgAvailability(tid: number): void {
  cache.delete(tid);
}

/** Test hook: drop the caches (and optionally the probe) so a test can change the environment between assertions. */
export function _resetIgAvailability(opts: { probe?: boolean } = {}): void {
  cache.clear();
  if (opts.probe !== false) { appProbe = null; probing = null; }
}
