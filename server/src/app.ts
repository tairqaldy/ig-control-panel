import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { config } from './config.js';
import { currentUser, requireAuth } from './auth.js';
import { auth } from './routes/auth.js';
import { items } from './routes/items.js';
import { importRoutes, harvestFormRoute } from './routes/import.js';
import { misc } from './routes/misc.js';
import { settings } from './routes/settings.js';
import { automations, webhooks } from './routes/automations.js';

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

export function createApp() {
  const app = new Hono();
  if (!config.isProd) app.use('*', logger());
  app.use('*', secureHeaders({ crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: false }));

  app.get('/api/health', (c) => c.json({ ok: true, version: process.env.npm_package_version || '1.0.0', time: new Date().toISOString() }));

  // Public: auth + webhooks + harvester script + token-protected direct upload from the harvester
  app.route('/api/auth', auth);
  app.route('/api/webhooks', webhooks);
  app.route('/api/import/harvest-form', harvestFormRoute);
  app.get('/harvester.js', (c) => {
    const p = findHarvester();
    if (!p) return c.text('// harvester not found', 404);
    let src = fs.readFileSync(p, 'utf8');
    const base = config.publicUrl || new URL(c.req.url).origin;
    src = src.replace(/__RESURFACE_URL__/g, base);
    return c.body(src, 200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' });
  });

  // Protected API
  app.use('/api/*', requireAuth);
  app.route('/api/items', items);
  app.route('/api/import', importRoutes);
  app.route('/api/settings', settings);
  app.route('/api/automations', automations);
  app.route('/api', misc);

  // Media (thumbnails/frames) — protected by session cookie
  app.use('/media/*', async (c, next) => {
    if (!currentUser(c)) return c.text('unauthorized', 401);
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
    app.get('/', (c) => c.text('Resurface API is running. Build the web app (npm run build) to serve the dashboard, or run the Vite dev server.'));
  }

  app.onError((err, c) => {
    console.error('[error]', c.req.method, c.req.path, err);
    return c.json({ error: err.message || 'Internal error' }, 500);
  });
  return app;
}
