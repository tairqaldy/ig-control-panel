/**
 * Route registration hooks so parallel feature work doesn't collide inside app.ts.
 * - mountPublicExtras: routes that must NOT require a session (OAuth callbacks, webhooks, device-token endpoints).
 * - mountProtectedExtras: routes behind requireAuth (`/api/*` middleware is already applied when this runs).
 * Add ONE line per feature; keep imports at the top. Order: instagram, companion, ask/onboarding.
 */
import type { Hono } from 'hono';
import { admin } from './backup.js';
import { startBackupJobs } from '../services/backup.js';
import { automationsStarter, instagram, instagramPublic } from './instagram.js';
import { startInstagramJobs } from '../services/instagram.js';
import { companion, companionDevice } from './companion.js';
import { startCompanionJobs } from '../services/companion.js';
import { askV2 } from './ask.js';
import { onboarding } from './onboarding.js';

export function mountPublicExtras(app: Hono) {
  void app;
  app.route('/api/instagram', instagramPublic); // callback, deauthorize, delete (server-instagram agent)
  app.route('/api/companion', companionDevice); // pair + bearer device-token endpoints: state, harvest, session (server-companion agent)
}

export function mountProtectedExtras(app: Hono) {
  app.route('/api/admin', admin); startBackupJobs();
  void app;
  app.route('/api/instagram', instagram); app.route('/api/automations', automationsStarter); startInstagramJobs(); // connect, account, analytics, starter rules + OWNER_PLAN/token-refresh boot hook (server-instagram agent)
  app.route('/api/companion', companion); startCompanionJobs(); // pair-code, devices, runs, notice + server-side harvest scheduler (server-companion agent)
  app.route('/api/ask', askV2); app.route('/api/onboarding', onboarding); // conversations, suggestions, onboarding (server-ask agent)
}
