import { Hono } from 'hono';
import { config } from '../config.js';
import { allSettings, db, getMeta, setSetting } from '../db.js';
import { currentTenant, tid } from '../auth.js';
import { apiKey, hasOpenAI, models, testOpenAI } from '../services/openai.js';
import { ffmpegPath } from '../services/media.js';
import { automationsConfigured, getMe, metaConfig } from '../services/automations.js';
import { worker } from '../services/worker.js';
import fs from 'node:fs';

export const settings = new Hono();

const EDITABLE = ['openai_api_key', 'analysis_model', 'ask_model', 'transcribe_model', 'meta_app_secret', 'meta_verify_token', 'ig_access_token', 'ig_user_id'] as const;
const SECRET = new Set(['openai_api_key', 'meta_app_secret', 'ig_access_token']);

function mask(v: string): string { return v.length <= 8 ? '••••' : `${v.slice(0, 4)}…${v.slice(-4)}`; }

function dirSize(dir: string, filter?: (name: string) => boolean): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (filter && !filter(e.name)) continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) total += dirSize(p);
      else total += fs.statSync(p).size;
    }
  } catch {}
  return total;
}

/** Media bytes used by one tenant: item dirs are named after item ids, which are prefixed `t{tid}_` for non-owner tenants. */
function tenantMediaBytes(t: number, isOwner: boolean): number {
  if (isOwner) return dirSize(config.mediaDir, (name) => !/^t\d+_/.test(name));
  const prefix = `t${t}_`;
  return dirSize(config.mediaDir, (name) => name.startsWith(prefix));
}

settings.get('/', (c) => {
  const sess = currentTenant(c)!;
  const t = sess.tid;
  const s = allSettings(t);
  const out: Record<string, unknown> = {};
  for (const k of EDITABLE) out[k] = s[k] ? (SECRET.has(k) ? mask(s[k]) : s[k]) : '';
  const m = metaConfig(t);
  const envKey = !!config.openaiApiKey;
  return c.json({
    values: out,
    effective: {
      openai: hasOpenAI(t) ? `configured (${envKey ? (sess.isOwner ? 'env' : 'hosted') : 'settings'}) ${sess.isOwner ? mask(apiKey(t)) : ''}`.trim() : 'not configured',
      models: models(t),
      embedDims: config.embedDims,
      concurrency: worker.tenantConcurrency(t),
      ffmpeg: sess.isOwner ? ffmpegPath() : (ffmpegPath() ? 'available' : null),
      dataDir: sess.isOwner ? config.dataDir : null,
      publicUrl: config.publicUrl,
      keepVideos: config.keepVideos,
      meta: { appSecret: !!m.appSecret, verifyToken: !!m.verifyToken, accessToken: m.accessToken ? mask(m.accessToken) : '', igUserId: m.igUserId, apiVersion: m.apiVersion, configured: automationsConfigured(t), envLocked: sess.isOwner ? { appSecret: !!config.metaAppSecret, verifyToken: !!config.metaVerifyToken, accessToken: !!config.igAccessToken, igUserId: !!config.igUserId } : { appSecret: false, verifyToken: false, accessToken: false, igUserId: false } },
      envLocked: { openai_api_key: envKey, analysis_model: !!process.env.OPENAI_MODEL, ask_model: !!process.env.OPENAI_ASK_MODEL, transcribe_model: !!process.env.OPENAI_TRANSCRIBE_MODEL },
      hosted: config.hosted,
      isOwner: sess.isOwner,
    },
    storage: { mediaBytes: tenantMediaBytes(t, sess.isOwner), dbBytes: sess.isOwner ? (() => { try { return fs.statSync(config.dbPath).size; } catch { return 0; } })() : 0 },
    igUsername: getMeta(t, 'ig_username'),
    version: process.env.npm_package_version || '1.0.0',
  });
});

settings.put('/', async (c) => {
  const sess = currentTenant(c)!;
  const t = sess.tid;
  const body = await c.req.json<Record<string, string | null>>();
  for (const k of EDITABLE) {
    if (!(k in body)) continue;
    // hosted tenants use the operator's OpenAI key/models
    if (!sess.isOwner && config.hosted && (k === 'openai_api_key' || k === 'analysis_model' || k === 'ask_model' || k === 'transcribe_model')) continue;
    const v = body[k];
    if (v === null || v === '') { setSetting(t, k, null); continue; }
    if (typeof v !== 'string') continue;
    // don't overwrite a secret with its masked display value
    if (SECRET.has(k) && v.includes('…')) continue;
    setSetting(t, k, v.trim().slice(0, 4000));
  }
  if (typeof (body as any).concurrency === 'number' && sess.isOwner) worker.concurrency = (body as any).concurrency;
  worker.kick();
  return c.json({ ok: true });
});

settings.post('/test-openai', async (c) => c.json(await testOpenAI(tid(c))));

settings.post('/test-meta', async (c) => {
  try {
    const me = await getMe(tid(c));
    return c.json({ ok: true, me });
  } catch (e: any) {
    return c.json({ ok: false, message: String(e?.message || e) });
  }
});

settings.get('/health-details', (c) => {
  const t = tid(c);
  const d = db();
  return c.json({
    items: (d.prepare('SELECT COUNT(*) AS n FROM items WHERE tenant_id = ?').get(t) as any).n,
    fts: (d.prepare('SELECT COUNT(*) AS n FROM items_fts WHERE tenant_id = ?').get(t) as any).n,
    embeddings: (d.prepare('SELECT COUNT(*) AS n FROM items WHERE tenant_id = ? AND embedding IS NOT NULL').get(t) as any).n,
    neighbors: (d.prepare('SELECT COUNT(*) AS n FROM item_neighbors n JOIN items i ON i.id = n.item_id WHERE i.tenant_id = ?').get(t) as any).n,
  });
});
