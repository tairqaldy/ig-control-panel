/**
 * Nightly SQLite backups to S3-compatible object storage (Cloudflare R2). No SDK: a minimal AWS SigV4 signer.
 *
 * Env: R2_ENDPOINT (https://<account>.r2.cloudflarestorage.com), R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 *      BACKUP_HOUR_UTC (default 3), BACKUP_KEEP (default 14). Disabled when the R2 vars are missing.
 *
 * What it does: `VACUUM INTO` a consistent snapshot of the live DB (safe with WAL, no lock on writers), gzip it,
 * PUT to `backups/resurface-YYYYMMDD-HHmm.db.gz`, delete objects beyond BACKUP_KEEP. Media (thumbnails/frames) is not
 * backed up — it is re-downloadable from Instagram while URLs are valid and is not needed to restore the notes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from '../config.js';
import { db, getMeta, GLOBAL, setMeta } from '../db.js';

export interface BackupConfig { endpoint: string; bucket: string; key: string; secret: string; hourUtc: number; keep: number }

export function backupConfig(): BackupConfig | null {
  const endpoint = (process.env.R2_ENDPOINT || '').replace(/\/$/, '');
  const bucket = process.env.R2_BUCKET || '';
  const key = process.env.R2_ACCESS_KEY_ID || '';
  const secret = process.env.R2_SECRET_ACCESS_KEY || '';
  if (!endpoint || !bucket || !key || !secret) return null;
  return { endpoint, bucket, key, secret, hourUtc: Math.min(23, Math.max(0, Number(process.env.BACKUP_HOUR_UTC || 3))), keep: Math.max(1, Number(process.env.BACKUP_KEEP || 14)) };
}

/* ---------------- SigV4 (S3, region "auto") ---------------- */
function signedHeaders(cfg: BackupConfig, method: string, pathname: string, query: string, body: Buffer | string, extra: Record<string, string> = {}) {
  const host = new URL(cfg.endpoint).host;
  const now = new Date();
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amz.slice(0, 8);
  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
  const headers: Record<string, string> = { host, 'x-amz-date': amz, 'x-amz-content-sha256': payloadHash, ...extra };
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const canonHeaders = names.map((k) => `${k}:${String(headers[Object.keys(headers).find((h) => h.toLowerCase() === k)!]).trim()}\n`).join('');
  const canonical = [method, pathname, query, canonHeaders, names.join(';'), payloadHash].join('\n');
  const scope = `${date}/auto/s3/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amz, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const hmac = (k: Buffer | string, d: string) => crypto.createHmac('sha256', k).update(d).digest();
  const kSig = hmac(hmac(hmac(hmac('AWS4' + cfg.secret, date), 'auto'), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', kSig).update(sts).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.key}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`;
  return headers;
}

async function s3(cfg: BackupConfig, method: string, objectKey: string, opts: { body?: Buffer | string; query?: string; headers?: Record<string, string> } = {}) {
  const pathname = `/${cfg.bucket}/${objectKey}`.replace(/\/+/g, '/');
  const query = opts.query || '';
  const body = opts.body ?? '';
  const headers = signedHeaders(cfg, method, pathname, query, body, opts.headers);
  const res = await fetch(`${cfg.endpoint}${pathname}${query ? '?' + query : ''}`, { method, headers, body: method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : (Buffer.isBuffer(body) ? new Uint8Array(body) : body) });
  return res;
}

export async function listBackups(cfg = backupConfig()): Promise<Array<{ key: string; size: number; lastModified: string }>> {
  if (!cfg) return [];
  const res = await s3(cfg, 'GET', '', { query: 'list-type=2&max-keys=1000&prefix=backups%2F' /* params must be sorted for SigV4 */ });
  const xml = await res.text();
  if (!res.ok) throw new Error(`R2 list failed: HTTP ${res.status} ${xml.slice(0, 200)}`);
  const out: Array<{ key: string; size: number; lastModified: string }> = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const c = m[1];
    const key = (c.match(/<Key>([^<]+)<\/Key>/) || [])[1];
    const size = Number((c.match(/<Size>(\d+)<\/Size>/) || [])[1] || 0);
    const lastModified = (c.match(/<LastModified>([^<]+)<\/LastModified>/) || [])[1] || '';
    if (key) out.push({ key, size, lastModified });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Snapshot the DB and upload it. Returns the object key. */
export async function runBackup(reason: 'scheduled' | 'manual' = 'manual'): Promise<{ key: string; bytes: number; ms: number; pruned: number }> {
  const cfg = backupConfig();
  if (!cfg) throw new Error('Backups are not configured (R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY).');
  const t0 = Date.now();
  const tmp = path.join(os.tmpdir(), `resurfly-backup-${process.pid}-${Date.now()}.db`);
  try {
    // A consistent copy without blocking writers (WAL); the copy has no WAL side files.
    db().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const raw = fs.readFileSync(tmp);
    const gz = zlib.gzipSync(raw, { level: 6 });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/T(\d{2})(\d{2}).*$/, '-$1$2');
    const key = `backups/resurface-${stamp}.db.gz`;
    const res = await s3(cfg, 'PUT', key, { body: gz, headers: { 'content-type': 'application/gzip', 'x-amz-meta-reason': reason, 'x-amz-meta-raw-bytes': String(raw.length) } });
    if (!res.ok) throw new Error(`R2 upload failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    // prune
    let pruned = 0;
    try {
      const all = await listBackups(cfg);
      const extra = all.slice(0, Math.max(0, all.length - cfg.keep));
      for (const o of extra) { const d = await s3(cfg, 'DELETE', o.key); if (d.ok || d.status === 204) pruned++; }
    } catch (e) { console.warn('[backup] prune failed', (e as Error).message); }
    const info = { key, bytes: gz.length, ms: Date.now() - t0, pruned };
    setMeta(GLOBAL, 'backup_last', JSON.stringify({ ...info, at: Math.floor(Date.now() / 1000), reason }));
    setMeta(GLOBAL, 'backup_last_error', null);
    console.log(`[backup] ${reason}: ${key} (${(gz.length / 1024 / 1024).toFixed(1)} MB, ${info.ms} ms, pruned ${pruned})`);
    return info;
  } catch (e) {
    setMeta(GLOBAL, 'backup_last_error', JSON.stringify({ at: Math.floor(Date.now() / 1000), message: (e as Error).message.slice(0, 300) }));
    throw e;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

export function backupStatus() {
  const cfg = backupConfig();
  return {
    configured: !!cfg,
    bucket: cfg?.bucket || null,
    hourUtc: cfg?.hourUtc ?? null,
    keep: cfg?.keep ?? null,
    last: JSON.parse(getMeta(GLOBAL, 'backup_last') || 'null'),
    lastError: JSON.parse(getMeta(GLOBAL, 'backup_last_error') || 'null'),
  };
}

let started = false;
/** Once a day at BACKUP_HOUR_UTC (checked every 10 minutes); also 2 minutes after boot if there is no backup from today. */
export function startBackupJobs() {
  if (started) return; started = true;
  const cfg = backupConfig();
  if (!cfg) { console.log('[backup] not configured (no R2 vars) — nightly DB backups disabled'); return; }
  console.log(`[backup] nightly DB backup → r2://${cfg.bucket}/backups at ${String(cfg.hourUtc).padStart(2, '0')}:00 UTC, keep ${cfg.keep}`);
  const dueToday = () => {
    const last = JSON.parse(getMeta(GLOBAL, 'backup_last') || 'null') as { at?: number } | null;
    const now = new Date();
    if (now.getUTCHours() < cfg.hourUtc) return false;
    if (!last?.at) return true;
    const lastDay = new Date(last.at * 1000).toISOString().slice(0, 10);
    return lastDay !== now.toISOString().slice(0, 10);
  };
  const tick = () => { if (dueToday()) runBackup('scheduled').catch((e) => console.warn('[backup] scheduled run failed:', (e as Error).message)); };
  const t1 = setTimeout(tick, 2 * 60_000); t1.unref();
  const t2 = setInterval(tick, 10 * 60_000); t2.unref();
  void config;
}
