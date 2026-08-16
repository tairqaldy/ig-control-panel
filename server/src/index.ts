import { serve } from '@hono/node-server';
import { config } from './config.js';
import { db, OWNER_TENANT } from './db.js';
import { createApp } from './app.js';
import { worker } from './services/worker.js';
import { loadEmbeddings } from './services/neighbors.js';
import { hasOpenAI } from './services/openai.js';
import { ffmpegPath } from './services/media.js';
import { backfillEstimatedCosts, recomputeSavedAtEst } from './services/scope.js';

db(); // run migrations
// backfill estimated save dates for libraries imported before this column existed (ranks are per tenant)
try {
  const tenants = db().prepare('SELECT DISTINCT tenant_id AS tid FROM items WHERE saved_rank IS NOT NULL AND saved_at_est IS NULL').all() as Array<{ tid: number }>;
  for (const t of tenants) recomputeSavedAtEst(t.tid);
} catch {}
try { const n = backfillEstimatedCosts(); if (n) console.log(`[costs] backfilled estimated cost for ${n} previously analyzed saves`); } catch {}
loadEmbeddings();

const app = createApp();
if (config.autoStartWorker) worker.start();

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`\n  Resurfly server → http://${info.address === '0.0.0.0' ? 'localhost' : info.address}:${info.port}`);
  console.log(`  data dir: ${config.dataDir}`);
  console.log(`  mode:     ${config.hosted ? `hosted (signups ${config.signupsEnabled ? 'open' : 'closed'}, trial ${config.trialDays}d, paddle ${config.paddle.env}${config.paddle.webhookSecret ? '' : ', NO webhook secret'})` : 'single-tenant'}`);
  console.log(`  openai:   ${hasOpenAI(OWNER_TENANT) ? 'configured' : 'NOT configured (set OPENAI_API_KEY)'}`);
  console.log(`  ffmpeg:   ${ffmpegPath()}`);
  console.log(`  login:    ${config.appUsername && config.appPasscode ? 'enabled' : config.hosted ? 'hosted users only (owner login DISABLED — set APP_USERNAME and APP_PASSCODE)' : 'DISABLED — set APP_USERNAME and APP_PASSCODE'}\n`);
});

process.on('SIGTERM', () => { worker.stop(); process.exit(0); });
process.on('SIGINT', () => { worker.stop(); process.exit(0); });
