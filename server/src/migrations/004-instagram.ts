/**
 * Migration 4 — Connect Instagram (OAuth accounts, encrypted tokens) + Instagram analytics cache.
 * Registered in ./index.ts. Owned by the server-instagram work (round 5, spec §1/§3).
 */
import type { ExtraMigration } from './index.js';

export const migration004Instagram: ExtraMigration = {
  id: 4,
  sql: `
CREATE TABLE IF NOT EXISTS ig_accounts (
  tenant_id INTEGER PRIMARY KEY,
  ig_user_id TEXT NOT NULL,
  app_scoped_id TEXT,
  username TEXT,
  name TEXT,
  profile_picture_url TEXT,
  account_type TEXT,
  followers_count INTEGER,
  follows_count INTEGER,
  media_count INTEGER,
  access_token_enc TEXT NOT NULL,
  token_expires_at INTEGER,
  scopes TEXT,
  connected_at INTEGER,
  refreshed_at INTEGER,
  last_error TEXT,
  webhook_subscribed INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ig_accounts_user ON ig_accounts(ig_user_id);

CREATE TABLE IF NOT EXISTS ig_media (
  tenant_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  caption TEXT,
  media_type TEXT,
  media_product_type TEXT,
  media_url TEXT,
  thumbnail_url TEXT,
  permalink TEXT,
  timestamp INTEGER,
  like_count INTEGER,
  comments_count INTEGER,
  insights_json TEXT,
  fetched_at INTEGER,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_ig_media_tenant_ts ON ig_media(tenant_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS ig_insights_daily (
  tenant_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL,
  PRIMARY KEY (tenant_id, day, metric)
);

CREATE TABLE IF NOT EXISTS ig_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  taken_at INTEGER NOT NULL,
  followers_count INTEGER,
  follows_count INTEGER,
  media_count INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ig_snapshots_tenant ON ig_snapshots(tenant_id, taken_at DESC);
`,
};
