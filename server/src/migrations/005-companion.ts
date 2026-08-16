/**
 * Migration 5 — Companion auto-harvest: paired devices (hashed bearer tokens, optional encrypted Instagram session for
 * server-side harvesting) and harvest runs (one row per sync, any source). Round 5 spec §4. Registered in ./index.ts.
 */
import type { ExtraMigration } from './index.js';

export const migration005Companion: ExtraMigration = {
  id: 5,
  sql: `
CREATE TABLE IF NOT EXISTS companion_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  name TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_harvest_at INTEGER,
  last_harvest_count INTEGER,
  ua TEXT,
  server_harvest INTEGER NOT NULL DEFAULT 0,
  ig_session_enc TEXT,
  ig_session_status TEXT,
  ig_session_checked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_companion_devices_tenant ON companion_devices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_companion_devices_server ON companion_devices(server_harvest, ig_session_status);

CREATE TABLE IF NOT EXISTS harvest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  device_id INTEGER,
  source TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  imported INTEGER NOT NULL DEFAULT 0,
  new_items INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_harvest_runs_tenant ON harvest_runs(tenant_id, started_at DESC);
`,
};
