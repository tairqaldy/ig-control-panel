import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Minimal .env loader (no dependency): first match of ./.env, ../.env or <repo>/.env; never overrides real env vars. */
(function loadDotEnv() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../.env'), path.resolve(here, '../../.env')]) {
    if (!fs.existsSync(p)) continue;
    try {
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (process.env[m[1]] === undefined) process.env[m[1]] = v;
      }
    } catch {}
    break;
  }
})();

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : def;
}

/**
 * Data directory. Absolute paths are used as-is. Relative paths (e.g. the default "./data") resolve against the
 * REPO ROOT — not the process cwd — so `npm run dev` (cwd = server/), `npm start` and `node server/dist/index.js`
 * all share the same ./data. Inside Docker/Railway a volume is expected at /data (set by the image or by
 * RAILWAY_VOLUME_MOUNT_PATH); a stray relative DATA_DIR from a local .env is ignored there.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
function resolveDataDir(): string {
  const raw = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
  const inContainer = fs.existsSync('/.dockerenv') || !!process.env.RAILWAY_ENVIRONMENT;
  if (raw && path.isAbsolute(raw)) return raw;
  if (inContainer) {
    if (raw) console.warn(`[config] ignoring relative DATA_DIR="${raw}" inside a container; using /data`);
    return '/data';
  }
  return path.resolve(REPO_ROOT, raw || './data');
}
const DATA_DIR = resolveDataDir();
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'media'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'tmp'), { recursive: true });

/** Session secret: env or auto-generated once and persisted next to the DB. */
function loadSessionSecret(): string {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, '.session-secret');
  try {
    const existing = fs.readFileSync(f, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {}
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(f, secret, { mode: 0o600 });
  return secret;
}

export const config = {
  port: num(process.env.PORT, 8080),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, 'resurface.db'),
  mediaDir: path.join(DATA_DIR, 'media'),
  tmpDir: path.join(DATA_DIR, 'tmp'),
  publicUrl: (process.env.PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` || '').replace(/\/$/, ''),

  // Auth (single user)
  appUsername: process.env.APP_USERNAME || '',
  appPasscode: process.env.APP_PASSCODE || '',
  sessionSecret: loadSessionSecret(),
  sessionDays: num(process.env.SESSION_DAYS, 30),

  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || undefined,
  analysisModel: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
  transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
  embedModel: process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small',
  embedDims: num(process.env.EMBED_DIMS, 512),
  askModel: process.env.OPENAI_ASK_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4-mini',
  visionFrames: num(process.env.VISION_FRAMES, 4),

  // Pipeline
  concurrency: Math.max(1, Math.min(8, num(process.env.ANALYSIS_CONCURRENCY, 3))),
  keepVideos: bool(process.env.KEEP_VIDEOS, false),
  maxVideoMb: num(process.env.MAX_VIDEO_MB, 80),
  transcribeMaxSeconds: num(process.env.TRANSCRIBE_MAX_SECONDS, 900),
  ffmpegPath: process.env.FFMPEG_PATH || '',
  autoStartWorker: bool(process.env.AUTO_START_WORKER, true),

  // Meta / Instagram automations (can also be set from the Settings UI; env wins)
  metaAppSecret: process.env.META_APP_SECRET || '',
  metaVerifyToken: process.env.META_VERIFY_TOKEN || '',
  igAccessToken: process.env.IG_ACCESS_TOKEN || '',
  igUserId: process.env.IG_USER_ID || '',
  graphApiVersion: process.env.GRAPH_API_VERSION || 'v23.0',
};

export type Config = typeof config;
