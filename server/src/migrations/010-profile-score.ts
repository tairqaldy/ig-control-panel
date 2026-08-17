/**
 * Migration 10 — Instagram Profile Score (ROUND7-SPEC §4, server-profile-score agent).
 * Registered in ./index.ts.
 *
 * `profile_goals` is one row per tenant: the answers to the five-question questionnaire, kept so a re-score does not
 * ask again and so the report can be read next week against the same stated goal.
 *
 * `profile_scores` is append-only — the whole report is stored as JSON and `overall` is duplicated into a column so
 * "how did I do last time" is one indexed read. Keeping the history is the point: the page shows the delta against the
 * previous score, which only works if old reports survive a re-score.
 *
 * The pasted profile of a tenant without an Instagram connection lives in `meta` (`profile_manual`), not here — it is
 * a small blob of user input, not a new relation, and `meta` already survives migrations and account deletion.
 */
import type { ExtraMigration } from './index.js';

export const migration010ProfileScore: ExtraMigration = {
  id: 10,
  sql: `
CREATE TABLE IF NOT EXISTS profile_goals (
  tenant_id INTEGER PRIMARY KEY,
  goal TEXT,
  niche TEXT,
  audience TEXT,
  offer TEXT,
  tone TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  overall INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profile_scores_tenant ON profile_scores(tenant_id, id);
`,
};
