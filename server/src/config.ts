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

/**
 * Session secret: env, or auto-generated once and persisted next to the DB.
 *
 * The file fallback is what lets a self-hoster run `docker run` with no configuration at all, and it stays. It is
 * also, on a hosted deployment, the key to the AES-256-GCM-encrypted Instagram tokens sitting on the same volume as
 * the database — so `/security` may not claim the key lives only in the deployment environment unless it does.
 * A hosted boot without SESSION_SECRET says so, loudly, every time.
 */
function loadSessionSecret(): string {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) return process.env.SESSION_SECRET;
  const hosted = /^(1|true|yes|on)$/i.test(String(process.env.HOSTED || ''));
  if (hosted) {
    // Refusing to boot is the kind failure here. The alternative — generating a key and writing it onto the same volume
    // as the ciphertext it protects — is silent, and a snapshot of that volume then holds both halves. It is also
    // unrecoverable in the other direction: once tokens are encrypted with a generated key, setting SESSION_SECRET
    // later signs everybody out and makes every stored Instagram token undecryptable. So a hosted deployment must be
    // told the key, and a hosted deployment that has lost it must be fixed by a human, not papered over at 3am.
    const f = path.join(DATA_DIR, '.session-secret');
    const generated = fs.existsSync(f);
    throw new Error(
      `SESSION_SECRET is not set and HOSTED is on, so the server will not start.\n\n` +
      `It is the key that encrypts Instagram access tokens and signs session cookies. Set it in the deployment environment ` +
      `(Railway → Variables) to a long random string.\n\n` +
      (generated
        ? `IMPORTANT: this deployment has been running on a generated key at ${f}. Set SESSION_SECRET to the exact contents of that file, ` +
          `or every logged-in user is signed out and every stored Instagram token becomes undecryptable.\n`
        : `Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"\n`),
    );
  }
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
  analysisModel: process.env.OPENAI_MODEL || 'gpt-5.4-nano',   // nano by default: analysis runs thousands of times and is the whole COGS story; set OPENAI_MODEL to override
  transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
  embedModel: process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small',
  embedDims: num(process.env.EMBED_DIMS, 512),
  // Deliberately NOT falling back to OPENAI_MODEL: analysis runs thousands of times and wants the cheap model,
  // Ask runs a handful of times and is the thing people judge the product by. Cutting Ask to nano saves cents and
  // costs the answer quality round 6 was spent on.
  askModel: process.env.OPENAI_ASK_MODEL || 'gpt-5.4-mini',
  visionFrames: num(process.env.VISION_FRAMES, 4),

  // Pipeline
  concurrency: Math.max(1, Math.min(8, num(process.env.ANALYSIS_CONCURRENCY, 3))),
  keepVideos: bool(process.env.KEEP_VIDEOS, false),
  maxVideoMb: num(process.env.MAX_VIDEO_MB, 80),
  transcribeMaxSeconds: num(process.env.TRANSCRIBE_MAX_SECONDS, 900),
  ffmpegPath: process.env.FFMPEG_PATH || '',
  autoStartWorker: bool(process.env.AUTO_START_WORKER, true),

  // Meta / Instagram automations (can also be set from the Settings UI; env wins — for the owner tenant only)
  metaAppId: process.env.META_APP_ID || '',
  metaAppSecret: process.env.META_APP_SECRET || '',
  metaVerifyToken: process.env.META_VERIFY_TOKEN || '',
  igAccessToken: process.env.IG_ACCESS_TOKEN || '',
  igUserId: process.env.IG_USER_ID || '',
  graphApiVersion: process.env.GRAPH_API_VERSION || 'v23.0',

  // Hosted mode (resurfly.com): public signup, one tenant per account, trial + paid plans. Default off = single-tenant open-source app.
  hosted: bool(process.env.HOSTED, false),
  signupsEnabled: bool(process.env.SIGNUPS_ENABLED, bool(process.env.HOSTED, false)),
  trialDays: Math.max(0, num(process.env.TRIAL_DAYS, 3)),
  ownerPlan: (['owner', 'studio', 'pro', 'trial', 'free'].includes(process.env.OWNER_PLAN || '') ? process.env.OWNER_PLAN : 'owner') as 'owner' | 'studio' | 'pro' | 'trial' | 'free',

  // Paddle billing (hosted mode only)
  paddle: {
    env: (process.env.PADDLE_ENV === 'production' ? 'production' : 'sandbox') as 'sandbox' | 'production',
    apiKey: process.env.PADDLE_API_KEY || '',
    clientToken: process.env.PADDLE_CLIENT_TOKEN || '',
    webhookSecret: process.env.PADDLE_WEBHOOK_SECRET || '',
    prices: {
      proMonth: process.env.PADDLE_PRICE_PRO_MONTH || '',
      proYear: process.env.PADDLE_PRICE_PRO_YEAR || '',
      studioMonth: process.env.PADDLE_PRICE_STUDIO_MONTH || '',
      studioYear: process.env.PADDLE_PRICE_STUDIO_YEAR || '',
    },
    // The same prices with `trial_period` on them (PADDLE_PRICE_*_TRIAL) live in services/paywall.ts, read at call
    // time like the credit packs — fixing the env of a running deploy must not need a rebuild.
  },

  /** Card before the trial starts (ROUND7 §1). Hosted only; self-hosters never see a paywall. Forced off when the trial price ids are missing — see services/paywall.ts. */
  trialRequiresCard: bool(process.env.TRIAL_REQUIRES_CARD, bool(process.env.HOSTED, false)),
};

export type Config = typeof config;
