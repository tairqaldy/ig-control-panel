/**
 * Companion auto-harvest (round 5 spec §4).
 *
 *  - Pairing: the dashboard issues a short-lived single-use code (`RSF-XXXX-XXXX`, 5 min, kept in meta); the browser
 *    extension exchanges it for a device token `cmp_<48 hex>` (only its sha256 is stored).
 *  - Device endpoints authenticate with `Authorization: Bearer cmp_…` (see routes/companion.ts).
 *  - Harvest: chunks of HarvestItems go through the SAME import path as the console harvester
 *    (services/importers.ts `upsertItems` + `afterImport`); one `harvests` quota unit per run (charged on the first chunk).
 *  - Opt-in server-side harvesting: the extension may hand over the user's Instagram session (encrypted at rest with
 *    services/crypto.ts); a 30-min scheduler walks the saved feed for tenants whose last run is > 12 h old, using the pure
 *    normalization/endpoint code shared with the browser (harvester/core.js). Cookies and tokens are never logged.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, getMeta, GLOBAL, j, now, setMeta } from '../db.js';
import type { HarvestItem } from '../types.js';
import { afterImport, upsertItems, type AfterImportResult } from './importers.js';
import { bumpUsage, checkQuota, finite, quotaMessage, type QuotaCheck } from './plans.js';
import { encryptSecret, tryDecryptSecret } from './crypto.js';
import { buildHeaders, IG_ORIGIN, looksLikeLoginPage, pageDelayMs, parseFeedPage, savedFeedUrl } from '../../../harvester/core.js';

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

function envBool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
/** SERVER_HARVEST_ENABLED — default true when hosted, false for the self-hosted app. */
export function serverHarvestEnabled(): boolean {
  return envBool(process.env.SERVER_HARVEST_ENABLED, config.hosted);
}

export const PAIR_CODE_TTL_MS = 5 * 60_000;
export const MIN_INTERVAL_MINUTES = 360;
export const KNOWN_IDS_LIMIT = 500;
export const MAX_CHUNK_ITEMS = 500;
export const SERVER_HARVEST_TICK_MS = 30 * 60_000;
export const SERVER_HARVEST_MIN_GAP_S = 12 * 3600;
export const SERVER_HARVEST_MAX_PAGES = 40;
export const SERVER_HARVEST_KNOWN_PAGES_TO_STOP = 3;
const RUN_STALE_S = 24 * 3600;
export const NOTICE_KEY = 'companion_notice';
export const SESSION_INVALID_MESSAGE = 'Instagram signed out the background session — open Companion and reconnect';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface CompanionDeviceRow {
  id: number;
  tenant_id: number;
  name: string | null;
  token_hash: string;
  created_at: number;
  last_seen_at: number | null;
  last_harvest_at: number | null;
  last_harvest_count: number | null;
  ua: string | null;
  server_harvest: number;
  ig_session_enc: string | null;
  ig_session_status: 'ok' | 'invalid' | null;
  ig_session_checked_at: number | null;
}

export interface HarvestRunRow {
  id: number;
  tenant_id: number;
  device_id: number | null;
  source: HarvestSource;
  started_at: number;
  finished_at: number | null;
  imported: number;
  new_items: number;
  status: 'running' | 'done' | 'failed' | 'abandoned' | 'invalid_session';
  error: string | null;
}

export type HarvestSource = 'companion' | 'server' | 'script' | 'zip' | 'urls';

export interface HarvestQuota { used: number; limit: number | null; remaining: number | null; resetsAt: number | null }

export interface CompanionNotice { kind: 'session_invalid' | string; message: string; at: number; deviceId?: number }

/** Decrypted Instagram web session handed over by the extension (opt-in). Never log this. */
export interface IgSession { sessionid: string; csrftoken: string; ds_user_id: string; ua: string; username?: string }

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const hashToken = (token: string) => sha256(token);
export const hashPairCode = (code: string) => sha256(`pair:${normalizePairCode(code)}`);

export function harvestQuota(tid: number): HarvestQuota {
  const q = checkQuota(tid, 'harvests', 1);
  return { used: q.used, limit: finite(q.limit), remaining: finite(q.remaining), resetsAt: q.resetsAt };
}

/** No 0/O/1/I to keep the code readable when typed by hand. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode(): string {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `RSF-${s.slice(0, 4)}-${s.slice(4)}`;
}
/** Accepts `RSF-ABCD-2345`, `rsf abcd 2345`, `ABCD2345`… → canonical `RSF-ABCD-2345` (or '' when unreadable). */
export function normalizePairCode(input: string): string {
  const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = raw.startsWith('RSF') ? raw.slice(3) : raw;
  if (body.length !== 8) return '';
  return `RSF-${body.slice(0, 4)}-${body.slice(4)}`;
}

/* ------------------------------------------------------------------ */
/* Pairing                                                             */
/* ------------------------------------------------------------------ */

interface PairRecord { tid: number; exp: number }

/** Drop expired codes (global meta, `companion_pair:<hash>`), cheap and idempotent. */
function sweepPairCodes() {
  const d = db();
  const rows = d.prepare("SELECT key, value FROM meta WHERE tenant_id = ? AND key LIKE 'companion_pair:%'").all(GLOBAL) as Array<{ key: string; value: string }>;
  const t = Date.now();
  const del = d.prepare('DELETE FROM meta WHERE tenant_id = ? AND key = ?');
  for (const r of rows) {
    const rec = j<PairRecord | null>(r.value, null);
    if (!rec || rec.exp < t) del.run(GLOBAL, r.key);
  }
}

/** Issue a fresh single-use pairing code for a tenant (replaces the tenant's previous code). `expiresAt` is epoch ms. */
export function createPairCode(tid: number): { code: string; expiresAt: number } {
  sweepPairCodes();
  const prev = j<{ hash: string } | null>(getMeta(tid, 'companion_pair_code'), null);
  if (prev?.hash) setMeta(GLOBAL, `companion_pair:${prev.hash}`, null);
  const code = randomCode();
  const hash = hashPairCode(code);
  const exp = Date.now() + PAIR_CODE_TTL_MS;
  setMeta(GLOBAL, `companion_pair:${hash}`, JSON.stringify({ tid, exp } satisfies PairRecord));
  setMeta(tid, 'companion_pair_code', JSON.stringify({ hash, exp }));
  return { code, expiresAt: exp };
}

/** Consume a pairing code → tenant id (null when unknown/expired). Single use. */
export function consumePairCode(code: string): number | null {
  const norm = normalizePairCode(code);
  if (!norm) return null;
  const key = `companion_pair:${hashPairCode(norm)}`;
  const rec = j<PairRecord | null>(getMeta(GLOBAL, key), null);
  if (!rec) return null;
  setMeta(GLOBAL, key, null);
  setMeta(rec.tid, 'companion_pair_code', null);
  if (rec.exp < Date.now()) return null;
  return rec.tid;
}

/** In-memory brute-force guard for the public pair endpoint: 10 attempts / 10 min per IP + 200 / 10 min globally. */
const pairAttempts = new Map<string, { n: number; reset: number }>();
let pairGlobal = { n: 0, reset: 0 };
export function pairAllowed(ip: string): boolean {
  const t = Date.now();
  if (pairGlobal.reset < t) pairGlobal = { n: 0, reset: t + 10 * 60_000 };
  pairGlobal.n += 1;
  if (pairGlobal.n > 200) return false;
  if (pairAttempts.size > 5000) for (const [k, v] of pairAttempts) if (v.reset < t) pairAttempts.delete(k);
  const rec = pairAttempts.get(ip);
  if (!rec || rec.reset < t) { pairAttempts.set(ip, { n: 1, reset: t + 10 * 60_000 }); return true; }
  rec.n += 1;
  return rec.n <= 10;
}

/** Create the device for a consumed code. Returns the plaintext token exactly once. */
export function pairDevice(tid: number, name: string | undefined | null, ua: string | undefined | null): { token: string; device: CompanionDeviceRow } {
  const token = `cmp_${crypto.randomBytes(24).toString('hex')}`;
  const t = now();
  const info = db().prepare('INSERT INTO companion_devices (tenant_id, name, token_hash, created_at, last_seen_at, ua) VALUES (?, ?, ?, ?, ?, ?)')
    .run(tid, String(name || 'Companion').slice(0, 80), hashToken(token), t, t, ua ? String(ua).slice(0, 300) : null);
  const device = getDevice(Number(info.lastInsertRowid))!;
  return { token, device };
}

/* ------------------------------------------------------------------ */
/* Devices                                                             */
/* ------------------------------------------------------------------ */

export function getDevice(id: number): CompanionDeviceRow | undefined {
  return db().prepare('SELECT * FROM companion_devices WHERE id = ?').get(id) as CompanionDeviceRow | undefined;
}

/** Resolve a bearer token (`cmp_…`) to its device; touches last_seen_at. Null when unknown. */
export function authenticateDevice(authorization: string | undefined | null, ua?: string | null): CompanionDeviceRow | null {
  const m = String(authorization || '').match(/^Bearer\s+(cmp_[a-f0-9]{48})$/i);
  if (!m) return null;
  const row = db().prepare('SELECT * FROM companion_devices WHERE token_hash = ?').get(hashToken(m[1])) as CompanionDeviceRow | undefined;
  if (!row) return null;
  const t = now();
  if (!row.last_seen_at || t - row.last_seen_at > 60) {
    db().prepare('UPDATE companion_devices SET last_seen_at = ?, ua = COALESCE(?, ua) WHERE id = ?').run(t, ua ? String(ua).slice(0, 300) : null, row.id);
    row.last_seen_at = t;
  }
  return row;
}

export function listDevices(tid: number): CompanionDeviceRow[] {
  return db().prepare('SELECT * FROM companion_devices WHERE tenant_id = ? ORDER BY id ASC').all(tid) as CompanionDeviceRow[];
}

export function deleteDevice(tid: number, id: number): boolean {
  return db().prepare('DELETE FROM companion_devices WHERE id = ? AND tenant_id = ?').run(id, tid).changes > 0;
}

/** Public JSON view of a device (never includes the token hash or the session). */
export function deviceJson(d: CompanionDeviceRow) {
  return {
    id: d.id,
    name: d.name,
    ua: d.ua,
    createdAt: d.created_at,
    lastSeenAt: d.last_seen_at,
    lastHarvestAt: d.last_harvest_at,
    lastHarvestCount: d.last_harvest_count,
    serverHarvest: d.server_harvest === 1,
    sessionStatus: d.ig_session_status,
    sessionCheckedAt: d.ig_session_checked_at,
  };
}

/* ------------------------------------------------------------------ */
/* Notice (per-tenant, meta `companion_notice`)                        */
/* ------------------------------------------------------------------ */

export function getNotice(tid: number): CompanionNotice | null {
  return j<CompanionNotice | null>(getMeta(tid, NOTICE_KEY), null);
}
export function setNotice(tid: number, notice: CompanionNotice | null) {
  setMeta(tid, NOTICE_KEY, notice ? JSON.stringify(notice) : null);
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

export function deviceState(device: CompanionDeviceRow) {
  const tid = device.tenant_id;
  const d = db();
  const known = d.prepare(`SELECT ig_pk FROM items WHERE tenant_id = ? AND ig_pk IS NOT NULL ORDER BY CASE WHEN saved_rank IS NULL THEN 1 ELSE 0 END, saved_rank ASC, saved_at DESC, created_at DESC LIMIT ${KNOWN_IDS_LIMIT}`).all(tid) as Array<{ ig_pk: string }>;
  const total = (d.prepare('SELECT COUNT(*) AS n FROM items WHERE tenant_id = ?').get(tid) as any).n as number;
  const lastRun = d.prepare("SELECT * FROM harvest_runs WHERE tenant_id = ? AND status = 'done' ORDER BY started_at DESC LIMIT 1").get(tid) as HarvestRunRow | undefined;
  const running = d.prepare("SELECT id, started_at, imported, new_items FROM harvest_runs WHERE tenant_id = ? AND device_id = ? AND status = 'running' AND started_at > ? ORDER BY id DESC LIMIT 1").get(tid, device.id, now() - RUN_STALE_S) as { id: number; started_at: number; imported: number; new_items: number } | undefined;
  return {
    knownIds: known.map((k) => k.ig_pk),
    total,
    lastHarvestAt: device.last_harvest_at ?? lastRun?.started_at ?? null,
    lastRunAt: lastRun?.started_at ?? null,
    harvestQuota: harvestQuota(tid),
    serverHarvest: { enabled: device.server_harvest === 1, status: device.ig_session_status, checkedAt: device.ig_session_checked_at, available: serverHarvestEnabled() },
    minIntervalMinutes: MIN_INTERVAL_MINUTES,
    openRun: running ? { runId: running.id, startedAt: running.started_at, imported: running.imported, newItems: running.new_items } : null,
    notice: getNotice(tid),
    igUsername: getMeta(tid, 'ig_username'),
  };
}

/* ------------------------------------------------------------------ */
/* Harvest runs (chunked import through the shared path)               */
/* ------------------------------------------------------------------ */

export function getRun(id: number): HarvestRunRow | undefined {
  return db().prepare('SELECT * FROM harvest_runs WHERE id = ?').get(id) as HarvestRunRow | undefined;
}
export function listRuns(tid: number, limit = 20): HarvestRunRow[] {
  return db().prepare('SELECT * FROM harvest_runs WHERE tenant_id = ? ORDER BY id DESC LIMIT ?').all(tid, limit) as HarvestRunRow[];
}
export function runJson(r: HarvestRunRow) {
  return { id: r.id, deviceId: r.device_id, source: r.source, startedAt: r.started_at, finishedAt: r.finished_at, imported: r.imported, newItems: r.new_items, status: r.status, error: r.error };
}

/** Runs still 'running' after 24 h are considered abandoned (extension closed mid-sync). */
function sweepStaleRuns(tid: number) {
  db().prepare("UPDATE harvest_runs SET status = 'abandoned', finished_at = ? WHERE tenant_id = ? AND status = 'running' AND started_at < ?").run(now(), tid, now() - RUN_STALE_S);
}

/** In-memory bookkeeping per open run: how many items were imported so far (rank offset) and the run's imports row. */
const runState = new Map<number, { rankOffset: number; importId: number | null; leftOut: number; queued: number }>();

export type BeginRunResult = { ok: true; run: HarvestRunRow } | { ok: false; code: 'quota'; quota: QuotaCheck };

/** Open a run: checks + charges ONE `harvests` quota unit. */
export function beginRun(tid: number, deviceId: number | null, source: HarvestSource): BeginRunResult {
  sweepStaleRuns(tid);
  const q = checkQuota(tid, 'harvests', 1);
  if (!q.ok) return { ok: false, code: 'quota', quota: q };
  const info = db().prepare("INSERT INTO harvest_runs (tenant_id, device_id, source, started_at, status) VALUES (?, ?, ?, ?, 'running')").run(tid, deviceId, source, now());
  bumpUsage(tid, 'harvests', 1);
  const run = getRun(Number(info.lastInsertRowid))!;
  runState.set(run.id, { rankOffset: 0, importId: null, leftOut: 0, queued: 0 });
  return { ok: true, run };
}

function stateOf(run: HarvestRunRow) {
  let s = runState.get(run.id);
  if (!s) {
    // process restarted mid-run: continue after the items imported so far
    s = { rankOffset: run.imported, importId: null, leftOut: 0, queued: 0 };
    runState.set(run.id, s);
  }
  return s;
}

/** Light validation of a HarvestItem chunk coming from a device (shape only; the importer tolerates missing fields). */
export function sanitizeItems(input: unknown): HarvestItem[] | null {
  if (!Array.isArray(input)) return null;
  if (input.length > MAX_CHUNK_ITEMS) return null;
  const out: HarvestItem[] = [];
  for (const it of input) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    const h = it as HarvestItem;
    if (!h.code && !h.url && !h.pk) continue;
    out.push(h);
  }
  return out;
}

/** Add one chunk to a run. Returns the shared import result. */
export function importRunChunk(run: HarvestRunRow, items: HarvestItem[], opts: { autoAnalyze?: boolean; filename?: string } = {}): { res: ReturnType<typeof upsertItems>; queue: AfterImportResult } {
  const s = stateOf(run);
  const res = upsertItems(run.tenant_id, items, 'harvest', opts.filename || `${run.source}-run-${run.id}.json`, { rankOffset: s.rankOffset, chunked: true, importId: s.importId ?? undefined });
  s.importId = res.importId;
  s.rankOffset += res.ids.length;
  const queue = afterImport(run.tenant_id, res.ids, opts.autoAnalyze !== false);
  s.leftOut += queue.leftOut;
  s.queued += queue.queued;
  db().prepare('UPDATE harvest_runs SET imported = imported + ?, new_items = new_items + ? WHERE id = ?').run(res.total, res.created, run.id);
  return { res, queue };
}

export function finishRun(run: HarvestRunRow, status: HarvestRunRow['status'] = 'done', error: string | null = null): HarvestRunRow {
  const t = now();
  db().prepare('UPDATE harvest_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?').run(status, t, error, run.id);
  const fresh = getRun(run.id)!;
  if (fresh.device_id) db().prepare('UPDATE companion_devices SET last_harvest_at = ?, last_harvest_count = ? WHERE id = ?').run(t, fresh.imported, fresh.device_id);
  runState.delete(run.id);
  return fresh;
}

export interface HarvestChunkInput {
  items?: unknown;
  done?: boolean;
  cursor?: string | null;
  runId?: number | null;
  /** optional: `{ username, ds_user_id }` from the extension (sets meta ig_username like the console harvester does) */
  account?: { username?: string | null; ds_user_id?: string | null } | null;
  autoAnalyze?: boolean;
}

export type HarvestChunkResult =
  | { ok: true; body: { runId: number | null; imported: number; newItems: number; leftOut: number; queued: number; done: boolean; chunk: { total: number; created: number; updated: number; skipped: number }; quota: HarvestQuota; leftOutMessage: string | null } }
  | { ok: false; code: 'quota'; quota: QuotaCheck }
  | { ok: false; code: 'bad_request' | 'bad_run'; error: string };

/**
 * `POST /api/companion/harvest` semantics (also used by the server-side harvester with source 'server'):
 * first chunk (no runId) opens a run and charges one `harvests` unit; later chunks reference the runId; `done: true`
 * closes it. An empty first chunk with `done` does not open a run (nothing new → no quota spent).
 */
export function harvestChunk(tid: number, deviceId: number | null, source: HarvestSource, input: HarvestChunkInput): HarvestChunkResult {
  const items = sanitizeItems(input.items ?? []);
  if (!items) return { ok: false, code: 'bad_request', error: `items must be an array of at most ${MAX_CHUNK_ITEMS} harvest items` };
  const done = !!input.done;
  if (input.account?.username && typeof input.account.username === 'string') setMeta(tid, 'ig_username', input.account.username.slice(0, 80));

  let run: HarvestRunRow | undefined;
  if (input.runId != null) {
    run = getRun(Number(input.runId));
    if (!run || run.tenant_id !== tid) return { ok: false, code: 'bad_run', error: 'unknown runId' };
    if (run.status !== 'running') return { ok: false, code: 'bad_run', error: `run ${run.id} is ${run.status}` };
  } else if (items.length) {
    const b = beginRun(tid, deviceId, source);
    if (!b.ok) return b;
    run = b.run;
  }

  if (!run) {
    // nothing to import and no run to close: just note the check-in
    if (deviceId) db().prepare('UPDATE companion_devices SET last_harvest_at = ?, last_harvest_count = COALESCE(last_harvest_count, 0) WHERE id = ?').run(now(), deviceId);
    return { ok: true, body: { runId: null, imported: 0, newItems: 0, leftOut: 0, queued: 0, done, chunk: { total: 0, created: 0, updated: 0, skipped: 0 }, quota: harvestQuota(tid), leftOutMessage: null } };
  }

  let chunk = { total: 0, created: 0, updated: 0, skipped: 0 };
  let leftOutQuota: QuotaCheck | null = null;
  if (items.length) {
    const { res, queue } = importRunChunk(run, items, { autoAnalyze: input.autoAnalyze });
    chunk = { total: res.total, created: res.created, updated: res.updated, skipped: res.skipped };
    if (queue.leftOut && queue.quota) leftOutQuota = queue.quota;
  }
  const s = stateOf(run);
  let fresh = getRun(run.id)!;
  if (done) fresh = finishRun(fresh, 'done');
  return {
    ok: true,
    body: {
      runId: fresh.id,
      imported: fresh.imported,
      newItems: fresh.new_items,
      leftOut: s.leftOut,
      queued: s.queued,
      done,
      chunk,
      quota: harvestQuota(tid),
      leftOutMessage: leftOutQuota ? quotaMessage(leftOutQuota) : null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Session opt-in (server-side harvesting)                             */
/* ------------------------------------------------------------------ */

export function setDeviceSession(deviceId: number, s: IgSession): void {
  const enc = encryptSecret(JSON.stringify({ sessionid: s.sessionid, csrftoken: s.csrftoken, ds_user_id: s.ds_user_id, ua: s.ua, username: s.username || undefined }));
  db().prepare('UPDATE companion_devices SET ig_session_enc = ?, server_harvest = 1, ig_session_status = NULL, ig_session_checked_at = NULL WHERE id = ?').run(enc, deviceId);
  const d = getDevice(deviceId);
  if (d) {
    const n = getNotice(d.tenant_id);
    if (n?.kind === 'session_invalid') setNotice(d.tenant_id, null);
  }
}

export function clearDeviceSession(deviceId: number): void {
  db().prepare('UPDATE companion_devices SET ig_session_enc = NULL, server_harvest = 0, ig_session_status = NULL, ig_session_checked_at = NULL WHERE id = ?').run(deviceId);
}

/** Decrypt a device's stored session (null when none / undecryptable — e.g. SESSION_SECRET rotated). */
export function deviceSession(d: CompanionDeviceRow): IgSession | null {
  const plain = tryDecryptSecret(d.ig_session_enc);
  if (!plain) return null;
  const s = j<Partial<IgSession> | null>(plain, null);
  if (!s || !s.sessionid || !s.csrftoken) return null;
  return { sessionid: s.sessionid, csrftoken: s.csrftoken, ds_user_id: s.ds_user_id || '', ua: s.ua || '', username: s.username };
}

export function markSessionInvalid(d: CompanionDeviceRow, reason: string): void {
  db().prepare("UPDATE companion_devices SET ig_session_status = 'invalid', ig_session_checked_at = ? WHERE id = ?").run(now(), d.id);
  setNotice(d.tenant_id, { kind: 'session_invalid', message: SESSION_INVALID_MESSAGE, at: now(), deviceId: d.id });
  console.warn(`[companion] tenant ${d.tenant_id} device ${d.id}: Instagram session invalid (${reason})`);
}
export function markSessionOk(d: CompanionDeviceRow): void {
  db().prepare("UPDATE companion_devices SET ig_session_status = 'ok', ig_session_checked_at = ? WHERE id = ?").run(now(), d.id);
}

/* ------------------------------------------------------------------ */
/* Server-side harvester                                               */
/* ------------------------------------------------------------------ */

export interface ServerHarvestDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxPages?: number;
  knownPagesToStop?: number;
  chunkSize?: number;
}

export type ServerHarvestOutcome =
  | { status: 'done'; runId: number | null; pages: number; fetched: number; imported: number; newItems: number }
  | { status: 'invalid_session'; runId: number | null; pages: number; reason: string }
  | { status: 'error'; runId: number | null; pages: number; error: string }
  | { status: 'quota' | 'no_session' | 'skipped'; runId: null; pages: 0; reason: string };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Walk the saved feed with a stored session and import through the shared path (source 'server').
 * Stops after `knownPagesToStop` consecutive pages of only-known items, or after `maxPages`.
 * 401/403/429, a login redirect or HTML instead of JSON → session marked invalid + tenant notice.
 */
export async function harvestWithSession(device: CompanionDeviceRow, deps: ServerHarvestDeps = {}): Promise<ServerHarvestOutcome> {
  const tid = device.tenant_id;
  const session = deviceSession(device);
  if (!session) return { status: 'no_session', runId: null, pages: 0, reason: 'no decryptable session' };
  const f = deps.fetch || fetch;
  const sleep = deps.sleep || defaultSleep;
  const maxPages = deps.maxPages ?? SERVER_HARVEST_MAX_PAGES;
  const stopAfter = deps.knownPagesToStop ?? SERVER_HARVEST_KNOWN_PAGES_TO_STOP;
  const chunkSize = deps.chunkSize ?? 100;

  const d = db();
  const known = new Set<string>();
  for (const r of d.prepare('SELECT ig_pk, shortcode FROM items WHERE tenant_id = ?').iterate(tid) as Iterable<{ ig_pk: string | null; shortcode: string | null }>) {
    if (r.ig_pk) known.add(`pk:${r.ig_pk}`);
    if (r.shortcode) known.add(`code:${r.shortcode}`);
  }
  const username = session.username || getMeta(tid, 'ig_username') || undefined;
  const headers = buildHeaders({ sessionid: session.sessionid, csrftoken: session.csrftoken, dsUserId: session.ds_user_id, ua: session.ua || undefined, username });

  let run: HarvestRunRow | null = null;
  let buffer: HarvestItem[] = [];
  let pages = 0, fetched = 0, consecutiveKnown = 0;
  let maxId = '';
  const seen = new Set<string>();

  const flush = (): { ok: true } | { ok: false; code: 'quota'; quota: QuotaCheck } => {
    if (!buffer.length) return { ok: true };
    if (!run) {
      const b = beginRun(tid, device.id, 'server');
      if (!b.ok) return b;
      run = b.run;
    }
    importRunChunk(run, buffer, { autoAnalyze: true });
    buffer = [];
    return { ok: true };
  };

  try {
    while (pages < maxPages) {
      let res: Response;
      try {
        res = await f(savedFeedUrl(maxId, IG_ORIGIN), { method: 'GET', headers, redirect: 'manual' });
      } catch (e: any) {
        if (run) finishRun(run, 'failed', `network: ${e?.message || e}`);
        return { status: 'error', runId: run ? (run as HarvestRunRow).id : null, pages, error: `network: ${e?.message || e}` };
      }
      pages++;
      const status = res.status;
      const location = res.headers.get('location') || '';
      if (status === 401 || status === 403 || status === 429 || (status >= 300 && status < 400 && /\/accounts\/login/.test(location))) {
        markSessionInvalid(device, `HTTP ${status}`);
        if (run) finishRun(run, 'invalid_session', `HTTP ${status}`);
        return { status: 'invalid_session', runId: run ? (run as HarvestRunRow).id : null, pages, reason: `HTTP ${status}` };
      }
      const text = await res.text();
      const ct = res.headers.get('content-type');
      if (looksLikeLoginPage(status, ct, text)) {
        markSessionInvalid(device, 'login page');
        if (run) finishRun(run, 'invalid_session', 'login page');
        return { status: 'invalid_session', runId: run ? (run as HarvestRunRow).id : null, pages, reason: 'login page' };
      }
      if (!res.ok) {
        if (run) finishRun(run, 'failed', `HTTP ${status}`);
        return { status: 'error', runId: run ? (run as HarvestRunRow).id : null, pages, error: `HTTP ${status}` };
      }
      let data: unknown;
      try { data = JSON.parse(text); } catch {
        markSessionInvalid(device, 'non-JSON response');
        if (run) finishRun(run, 'invalid_session', 'non-JSON response');
        return { status: 'invalid_session', runId: run ? (run as HarvestRunRow).id : null, pages, reason: 'non-JSON response' };
      }
      const page = parseFeedPage(data);
      fetched += page.rawCount;
      let unknownOnPage = 0;
      for (const it of page.items as HarvestItem[]) {
        const key = it.pk ? `pk:${it.pk}` : `code:${it.code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const isKnown = (it.pk && known.has(`pk:${it.pk}`)) || (it.code && known.has(`code:${it.code}`));
        if (!isKnown) unknownOnPage++;
        buffer.push(it); // known items are refreshed too (media URLs expire) — same as a console harvest
        if (buffer.length >= chunkSize) {
          const fl = flush();
          if (!fl.ok) return { status: 'quota', runId: null, pages: 0, reason: quotaMessage(fl.quota) };
        }
      }
      consecutiveKnown = page.rawCount > 0 && unknownOnPage === 0 ? consecutiveKnown + 1 : 0;
      if (!page.moreAvailable || consecutiveKnown >= stopAfter) break;
      maxId = page.nextMaxId;
      await sleep(pageDelayMs());
    }
    const fl = flush();
    if (!fl.ok) return { status: 'quota', runId: null, pages: 0, reason: quotaMessage(fl.quota) };
    markSessionOk(device);
    if (run) {
      const fin = finishRun(run, 'done');
      return { status: 'done', runId: fin.id, pages, fetched, imported: fin.imported, newItems: fin.new_items };
    }
    d.prepare('UPDATE companion_devices SET last_harvest_at = ? WHERE id = ?').run(now(), device.id);
    return { status: 'done', runId: null, pages, fetched, imported: 0, newItems: 0 };
  } catch (e: any) {
    if (run) finishRun(run, 'failed', String(e?.message || e).slice(0, 300));
    return { status: 'error', runId: run ? (run as HarvestRunRow).id : null, pages, error: String(e?.message || e) };
  }
}

/** Devices due for a server-side run: opted in, session present & not invalid, tenant's last run > 12 h ago, no run in flight. */
export function dueDevices(nowSec = now()): CompanionDeviceRow[] {
  const d = db();
  const rows = d.prepare("SELECT * FROM companion_devices WHERE server_harvest = 1 AND ig_session_enc IS NOT NULL AND (ig_session_status IS NULL OR ig_session_status != 'invalid') ORDER BY last_seen_at DESC, id DESC").all() as CompanionDeviceRow[];
  const out: CompanionDeviceRow[] = [];
  const seenTenant = new Set<number>();
  for (const r of rows) {
    if (seenTenant.has(r.tenant_id)) continue; // one device per tenant per tick (the most recently seen)
    seenTenant.add(r.tenant_id);
    const last = d.prepare("SELECT MAX(started_at) AS t FROM harvest_runs WHERE tenant_id = ? AND status != 'abandoned'").get(r.tenant_id) as { t: number | null };
    if (last.t && nowSec - last.t < SERVER_HARVEST_MIN_GAP_S) continue;
    const open = d.prepare("SELECT COUNT(*) AS n FROM harvest_runs WHERE tenant_id = ? AND status = 'running' AND started_at > ?").get(r.tenant_id, nowSec - RUN_STALE_S) as { n: number };
    if (open.n > 0) continue;
    out.push(r);
  }
  return out;
}

let tickRunning = false;
/** One scheduler pass: run every due tenant sequentially (Instagram-friendly). Returns per-device outcomes. */
export async function runServerHarvestTick(deps: ServerHarvestDeps = {}): Promise<Array<{ deviceId: number; tenantId: number; outcome: ServerHarvestOutcome }>> {
  if (tickRunning) return [];
  tickRunning = true;
  const results: Array<{ deviceId: number; tenantId: number; outcome: ServerHarvestOutcome }> = [];
  try {
    for (const dev of dueDevices()) {
      let outcome: ServerHarvestOutcome;
      try { outcome = await harvestWithSession(dev, deps); } catch (e: any) { outcome = { status: 'error', runId: null, pages: 0, error: String(e?.message || e) }; }
      results.push({ deviceId: dev.id, tenantId: dev.tenant_id, outcome });
      if (outcome.status === 'done') console.log(`[companion] server harvest tenant ${dev.tenant_id}: ${outcome.newItems} new / ${outcome.imported} imported (${outcome.pages} pages)`);
      else if (outcome.status !== 'skipped') console.warn(`[companion] server harvest tenant ${dev.tenant_id}: ${outcome.status}${'reason' in outcome ? ` (${outcome.reason})` : 'error' in outcome ? ` (${outcome.error})` : ''}`);
    }
  } finally {
    tickRunning = false;
  }
  return results;
}

let jobsStarted = false;
let jobTimer: NodeJS.Timeout | null = null;
/** Start the 30-min scheduler once (called from mountProtectedExtras). No-op unless SERVER_HARVEST_ENABLED. */
export function startCompanionJobs(): boolean {
  if (jobsStarted) return false;
  jobsStarted = true;
  if (!serverHarvestEnabled()) { console.log('[companion] server-side harvest disabled (SERVER_HARVEST_ENABLED)'); return false; }
  const kick = () => { runServerHarvestTick().catch((e) => console.warn('[companion] tick failed', e)); };
  jobTimer = setInterval(kick, SERVER_HARVEST_TICK_MS);
  jobTimer.unref?.();
  const first = setTimeout(kick, 90_000); // let the worker/boot settle first
  first.unref?.();
  console.log('[companion] server-side harvest scheduler started (every 30 min)');
  return true;
}
export function stopCompanionJobs() {
  if (jobTimer) clearInterval(jobTimer);
  jobTimer = null;
  jobsStarted = false;
}
