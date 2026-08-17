/**
 * Migration 11 — "tell me when Instagram opens" (ROUND7-SPEC §3, server-instagram-availability agent).
 *
 * While our Meta app is in Development mode most people cannot connect an account at all. Instead of a button that
 * fails, they leave an address here. One row per tenant (the primary key is what makes the endpoint idempotent);
 * `notified_at` stays NULL until the e-mail goes out, so the "who still needs telling" query is a plain filter.
 */
import type { ExtraMigration } from './index.js';

export const migration011IgWaitlist: ExtraMigration = {
  id: 11,
  sql: `
CREATE TABLE IF NOT EXISTS ig_waitlist (
  tenant_id INTEGER PRIMARY KEY,
  email TEXT,
  source TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  notified_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ig_waitlist_pending ON ig_waitlist(notified_at, created_at);
`,
};
