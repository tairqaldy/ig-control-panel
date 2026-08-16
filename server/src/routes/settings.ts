import { Hono } from 'hono';
import { config } from '../config.js';
import { allSettings, db, getMeta, setSetting } from '../db.js';
import { apiKey, hasOpenAI, models, testOpenAI } from '../services/openai.js';
import { ffmpegPath } from '../services/media.js';
import { automationsConfigured, getMe, metaConfig } from '../services/automations.js';
import { worker } from '../services/worker.js';
import fs from 'node:fs';

export const settings = new Hono();

const EDITABLE = ['openai_api_key', 'analysis_model', 'ask_model', 'transcribe_model', 'meta_app_secret', 'meta_verify_token', 'ig_access_token', 'ig_user_id'] as const;
const SECRET = new Set(['openai_api_key', 'meta_app_secret', 'ig_access_token']);

function mask(v: string): string { return v.length <= 8 ? '••••' : `${v.slice(0, 4)}…${v.slice(-4)}`; }

function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) total += dirSize(p);
      else total += fs.statSync(p).size;
    }
  } catch {}
  return total;
}

settings.get('/', (c) => {
  const s = allSettings();
  const out: Record<string, unknown> = {};
  for (const k of EDITABLE) out[k] = s[k] ? (SECRET.has(k) ? mask(s[k]) : s[k]) : '';
  const m = metaConfig();
  return c.json({
    values: out,
    effective: {
      openai: hasOpenAI() ? `configured (${config.openaiApiKey ? 'env' : 'settings'}) ${mask(apiKey())}` : 'not configured',
      models: models(),
      embedDims: config.embedDims,
      concurrency: worker.concurrency,
      ffmpeg: ffmpegPath(),
      dataDir: config.dataDir,
      publicUrl: config.publicUrl,
      keepVideos: config.keepVideos,
      meta: { appSecret: !!m.appSecret, verifyToken: !!m.verifyToken, accessToken: m.accessToken ? mask(m.accessToken) : '', igUserId: m.igUserId, apiVersion: m.apiVersion, configured: automationsConfigured(), envLocked: { appSecret: !!config.metaAppSecret, verifyToken: !!config.metaVerifyToken, accessToken: !!config.igAccessToken, igUserId: !!config.igUserId } },
      envLocked: { openai_api_key: !!config.openaiApiKey, analysis_model: !!process.env.OPENAI_MODEL, ask_model: !!process.env.OPENAI_ASK_MODEL, transcribe_model: !!process.env.OPENAI_TRANSCRIBE_MODEL },
    },
    storage: { mediaBytes: dirSize(config.mediaDir), dbBytes: (() => { try { return fs.statSync(config.dbPath).size; } catch { return 0; } })() },
    igUsername: getMeta('ig_username'),
    version: process.env.npm_package_version || '1.0.0',
  });
});

settings.put('/', async (c) => {
  const body = await c.req.json<Record<string, string | null>>();
  for (const k of EDITABLE) {
    if (!(k in body)) continue;
    const v = body[k];
    if (v === null || v === '') { setSetting(k, null); continue; }
    if (typeof v !== 'string') continue;
    // don't overwrite a secret with its masked display value
    if (SECRET.has(k) && v.includes('…')) continue;
    setSetting(k, v.trim());
  }
  if (typeof (body as any).concurrency === 'number') worker.concurrency = (body as any).concurrency;
  worker.kick();
  return c.json({ ok: true });
});

settings.post('/test-openai', async (c) => c.json(await testOpenAI()));

settings.post('/test-meta', async (c) => {
  try {
    const me = await getMe();
    return c.json({ ok: true, me });
  } catch (e: any) {
    return c.json({ ok: false, message: String(e?.message || e) });
  }
});

settings.get('/health-details', (c) => {
  const d = db();
  return c.json({
    items: (d.prepare('SELECT COUNT(*) AS n FROM items').get() as any).n,
    fts: (d.prepare('SELECT COUNT(*) AS n FROM items_fts').get() as any).n,
    embeddings: (d.prepare('SELECT COUNT(*) AS n FROM items WHERE embedding IS NOT NULL').get() as any).n,
    neighbors: (d.prepare('SELECT COUNT(*) AS n FROM item_neighbors').get() as any).n,
  });
});
