import { serve } from '@hono/node-server';
import { config } from './config.js';
import { db } from './db.js';
import { createApp } from './app.js';
import { worker } from './services/worker.js';
import { loadEmbeddings } from './services/neighbors.js';
import { hasOpenAI } from './services/openai.js';
import { ffmpegPath } from './services/media.js';
import { backfillEstimatedCosts, recomputeSavedAtEst } from './services/scope.js';

db(); // run migrations
// backfill estimated save dates for libraries imported before this column existed
try { if ((db().prepare("SELECT COUNT(*) AS n FROM items WHERE saved_rank IS NOT NULL AND saved_at_est IS NULL").get() as any).n > 0) recomputeSavedAtEst(); } catch {}
try { const n = backfillEstimatedCosts(); if (n) console.log(`[costs] backfilled estimated cost for ${n} previously analyzed saves`); } catch {}
loadEmbeddings();

const app = createApp();
if (config.autoStartWorker) worker.start();

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`\n  Resurface server → http://${info.address === '0.0.0.0' ? 'localhost' : info.address}:${info.port}`);
  console.log(`  data dir: ${config.dataDir}`);
  console.log(`  openai:   ${hasOpenAI() ? 'configured' : 'NOT configured (set OPENAI_API_KEY)'}`);
  console.log(`  ffmpeg:   ${ffmpegPath()}`);
  console.log(`  login:    ${config.appUsername && config.appPasscode ? 'enabled' : 'DISABLED — set APP_USERNAME and APP_PASSCODE'}\n`);
});

process.on('SIGTERM', () => { worker.stop(); process.exit(0); });
process.on('SIGINT', () => { worker.stop(); process.exit(0); });
