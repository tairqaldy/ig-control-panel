import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { config } from './config.js';
import { currentTenant, requireAuth } from './auth.js';
import { db } from './db.js';
import { auth } from './routes/auth.js';
import { items } from './routes/items.js';
import { importRoutes, harvestFormRoute } from './routes/import.js';
import { misc } from './routes/misc.js';
import { settings } from './routes/settings.js';
import { automations, webhooks } from './routes/automations.js';
import { account, billing, paddleWebhook, publicPlans } from './routes/billing.js';
import { mountPublicExtras, mountProtectedExtras } from './routes/extra.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Locate the built web app (web/dist) relative to the server, in dev and in Docker. */
export function findWebDist(): string | null {
  const candidates = [
    process.env.WEB_DIST,
    path.resolve(__dirname, '../../web/dist'),
    path.resolve(__dirname, '../web/dist'),
    path.resolve(process.cwd(), 'web/dist'),
    path.resolve(process.cwd(), '../web/dist'),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (fs.existsSync(path.join(c, 'index.html'))) return c;
  return null;
}

export function findHarvester(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../harvester/harvester.js'),
    path.resolve(__dirname, '../harvester/harvester.js'),
    path.resolve(process.cwd(), 'harvester/harvester.js'),
    path.resolve(process.cwd(), '../harvester/harvester.js'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

/**
 * item dir name (= safeName(item id) = item id for shortcodes/hashes) → tenant id; small cache so thumbnails don't cost a
 * DB read each. Ids are tenant-prefixed for every tenant but the owner, so an id never changes hands.
 */
const mediaOwner = new Map<string, number>();
function tenantOfMediaDir(dir: string): number | null {
  const hit = mediaOwner.get(dir);
  if (hit !== undefined) return hit;
  const r = db().prepare('SELECT tenant_id FROM items WHERE id = ?').get(dir) as { tenant_id: number } | undefined;
  if (!r) return null;
  if (mediaOwner.size > 20_000) mediaOwner.clear();
  mediaOwner.set(dir, r.tenant_id);
  return r.tenant_id;
}

export function createApp() {
  const app = new Hono();
  if (!config.isProd) app.use('*', logger());
  app.use('*', secureHeaders({ crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: false }));

  app.get('/api/health', (c) => c.json({ ok: true, version: process.env.npm_package_version || '1.0.0', time: new Date().toISOString(), hosted: config.hosted }));

  // Public: auth + webhooks + price catalog + harvester script + token-protected direct upload from the harvester
  app.route('/api/auth', auth);
  app.route('/api/webhooks', webhooks);
  app.route('/api/webhooks/paddle', paddleWebhook);
  app.route('/api/plans', publicPlans);
  app.route('/api/import/harvest-form', harvestFormRoute);
  mountPublicExtras(app);
  app.get('/harvester.js', (c) => {
    const p = findHarvester();
    if (!p) return c.text('// harvester not found', 404);
    let src = fs.readFileSync(p, 'utf8');
    const base = config.publicUrl || new URL(c.req.url).origin;
    src = src.replace(/__RESURFLY_URL__/g, base);
    return c.body(src, 200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' });
  });

  // Protected API (every route below sees the tenant via c.get('tenant') / tid(c))
  app.use('/api/*', requireAuth);
  app.route('/api/items', items);
  app.route('/api/import', importRoutes);
  app.route('/api/settings', settings);
  app.route('/api/automations', automations);
  app.route('/api/billing', billing);
  app.route('/api', account);
  app.route('/api', misc);
  mountProtectedExtras(app);

  // Media (thumbnails/frames) — protected by session cookie AND the item must belong to the session's tenant
  app.use('/media/*', async (c, next) => {
    const s = currentTenant(c);
    if (!s) return c.text('unauthorized', 401);
    let dir = '';
    try { dir = decodeURIComponent(c.req.path.replace(/^\/media\/?/, '').split('/')[0] || ''); } catch { return c.text('bad request', 400); }
    if (!dir || dir === '.' || dir === '..') return c.text('not found', 404);
    const owner = tenantOfMediaDir(dir);
    if (owner === null || owner !== s.tid) return c.text('not found', 404);
    await next();
  });
  app.use('/media/*', serveStatic({ root: path.relative(process.cwd(), config.mediaDir) || '.', rewriteRequestPath: (p) => p.replace(/^\/media/, ''), onFound: (_p, c) => c.header('cache-control', 'private, max-age=31536000, immutable') }));

  // SPA
  const dist = findWebDist();
  if (dist) {
    const rel = path.relative(process.cwd(), dist) || '.';
    app.use('/assets/*', serveStatic({ root: rel, onFound: (_p, c) => c.header('cache-control', 'public, max-age=31536000, immutable') }));
    app.use('/*', serveStatic({ root: rel }));
    const indexHtml = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    app.get('*', (c) => c.html(indexHtml));
  } else {
    app.get('/', (c) => c.text('Resurfly API is running. Build the web app (npm run build) to serve the dashboard, or run the Vite dev server.'));
  }

  app.onError((err, c) => {
    console.error('[error]', c.req.method, c.req.path, err);
    return c.json({ error: err.message || 'Internal error' }, 500);
  });
  return app;
}
