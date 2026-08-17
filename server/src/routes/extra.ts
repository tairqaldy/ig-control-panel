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
import { automationsExtra, instagramMedia } from './automations-extra.js';
import { instagramAvailability } from './instagram-availability.js';
import { profileScore } from './profile-score.js';
import { paywall, paywallGuard } from './paywall.js';
import { startMediaSweep } from '../services/media-sweep.js';

export function mountPublicExtras(app: Hono) {
  void app;
  app.route('/api/instagram', instagramPublic); // callback, deauthorize, delete (server-instagram agent)
  app.route('/api/companion', companionDevice); // pair + bearer device-token endpoints: state, harvest, session (server-companion agent)
  app.use('/api/*', paywallGuard); // 402 while a signup has no card on file — must be registered before the protected routes (server-paywall agent)
}

export function mountProtectedExtras(app: Hono) {
  app.route('/api/admin', admin); startBackupJobs(); startMediaSweep(); // + the orphaned-media sweep that finishes an interrupted account deletion (fix pass §7)
  void app;
  app.route('/api/instagram', instagram); app.route('/api/automations', automationsStarter); startInstagramJobs(); // connect, account, analytics, starter rules + OWNER_PLAN/token-refresh boot hook (server-instagram agent)
  app.route('/api/companion', companion); startCompanionJobs(); // pair-code, devices, runs, notice + server-side harvest scheduler (server-companion agent)
  app.route('/api/ask', askV2); app.route('/api/onboarding', onboarding); // conversations, suggestions, onboarding (server-ask agent)
  app.route('/api/automations', automationsExtra); app.route('/api/instagram', instagramMedia); // diagnostics, simulate, resubscribe, per-rule test-send + post picker (server-automations agent)
  app.route('/api/instagram', instagramAvailability); // availability + waitlist: never offer a Connect button that cannot work (server-instagram-availability agent)
  app.route('/api/profile', profileScore); // questions, goals, score (server-profile-score agent)
  app.route('/api/paywall', paywall); // what the /start screen needs: locked?, plans, trial price ids (server-paywall agent)
}
