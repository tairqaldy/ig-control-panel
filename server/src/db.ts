import Database from 'better-sqlite3';
import { config } from './config.js';
import { reindexAll } from './services/search.js';
import { EXTRA_MIGRATIONS } from './migrations/index.js';

export type DB = Database.Database;

/** Tenant id used for global (server-wide) settings/meta rows: worker pause state, concurrency, paddle event ids. */
export const GLOBAL = 0;
/** The open-source / owner tenant. Its item ids are unprefixed and its env credentials apply. */
export const OWNER_TENANT = 1;

let _db: DB | null = null;

export function db(): DB {
  if (_db) return _db;
  const d = new Database(config.dbPath);
  d.pragma('journal_mode = WAL');
  d.pragma('synchronous = NORMAL');
  d.pragma('foreign_keys = ON');
  d.pragma('busy_timeout = 5000');
  _db = d; // set before migrating: post-migration hooks (FTS reindex) go through db()
  try { migrate(d); } catch (e) { _db = null; throw e; }
  ensureOwnerUser(d);
  return d;
}

interface Migration { id: number; sql: string; after?: (d: DB) => void }

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    sql: `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  ig_pk TEXT,
  shortcode TEXT,
  url TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'harvest',
  media_type TEXT NOT NULL DEFAULT 'unknown',
  product_type TEXT,
  author_username TEXT,
  author_name TEXT,
  author_pk TEXT,
  author_verified INTEGER DEFAULT 0,
  author_pic_url TEXT,
  caption TEXT,
  alt_text TEXT,
  location TEXT,
  music_title TEXT,
  music_artist TEXT,
  like_count INTEGER,
  comment_count INTEGER,
  play_count INTEGER,
  duration REAL,
  taken_at INTEGER,
  saved_at INTEGER,
  saved_rank INTEGER,
  collections TEXT,
  media_urls TEXT,
  media_urls_fetched_at INTEGER,
  raw TEXT,
  media_status TEXT NOT NULL DEFAULT 'pending',
  media_error TEXT,
  thumb_path TEXT,
  frames TEXT,
  video_path TEXT,
  transcript TEXT,
  transcript_lang TEXT,
  analysis_status TEXT NOT NULL DEFAULT 'pending',
  analysis_error TEXT,
  analysis TEXT,
  analysis_model TEXT,
  analyzed_at INTEGER,
  embedding BLOB,
  embedding_model TEXT,
  queue_state TEXT NOT NULL DEFAULT 'idle',
  queued_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  user_notes TEXT,
  user_tags TEXT,
  last_resurfaced_at INTEGER,
  resurface_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_shortcode ON items(shortcode);
CREATE INDEX IF NOT EXISTS idx_items_saved ON items(saved_rank ASC, saved_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_author ON items(author_username);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(analysis_status, media_status);
CREATE INDEX IF NOT EXISTS idx_items_queue ON items(queue_state, queued_at);
CREATE INDEX IF NOT EXISTS idx_items_type ON items(media_type);

CREATE TABLE IF NOT EXISTS item_tags (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'ai',
  PRIMARY KEY (item_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag);

CREATE TABLE IF NOT EXISTS item_neighbors (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  neighbor_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  PRIMARY KEY (item_id, neighbor_id)
);
CREATE INDEX IF NOT EXISTS idx_item_neighbors_score ON item_neighbors(item_id, score DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  item_id UNINDEXED, title, summary, key_points, tags, caption, transcript, author, entities,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  filename TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger_type TEXT NOT NULL,
  match_mode TEXT NOT NULL DEFAULT 'contains',
  keywords TEXT NOT NULL DEFAULT '[]',
  reply_text TEXT NOT NULL DEFAULT '',
  reply_link TEXT,
  public_reply_text TEXT,
  cooldown_minutes INTEGER NOT NULL DEFAULT 1440,
  priority INTEGER NOT NULL DEFAULT 100,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  direction TEXT NOT NULL,
  sender_id TEXT,
  sender_username TEXT,
  text TEXT,
  rule_id INTEGER,
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_automation_events_ts ON automation_events(ts DESC);

CREATE TABLE IF NOT EXISTS automation_contacts (
  ig_id TEXT PRIMARY KEY,
  username TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_rule_hits TEXT
);
`,
  },
  {
    id: 2,
    sql: `
ALTER TABLE items ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN exclude_reason TEXT;
ALTER TABLE items ADD COLUMN saved_at_est INTEGER;
ALTER TABLE items ADD COLUMN usage TEXT;
ALTER TABLE items ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_items_excluded ON items(excluded);
CREATE INDEX IF NOT EXISTS idx_items_saved_est ON items(saved_at_est);
`,
  },
  {
    // Multi-tenant (hosted mode). Tenant 1 = the owner / open-source single user; everything existing is assigned to it.
    id: 3,
    sql: `
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  plan TEXT NOT NULL DEFAULT 'trial',
  plan_status TEXT NOT NULL DEFAULT 'active',
  trial_ends_at INTEGER,
  plan_started_at INTEGER,
  plan_renews_at INTEGER,
  paddle_customer_id TEXT,
  paddle_subscription_id TEXT,
  paddle_price_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  is_owner INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
CREATE TABLE IF NOT EXISTS usage (
  tenant_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  metric TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period, metric)
);
INSERT OR IGNORE INTO tenants (id, name, plan, plan_status, created_at, updated_at) VALUES (1, 'owner', 'owner', 'active', strftime('%s','now'), strftime('%s','now'));

ALTER TABLE items ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_items_tenant ON items(tenant_id);
DROP INDEX IF EXISTS idx_items_shortcode;
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_tenant_shortcode ON items(tenant_id, shortcode);

ALTER TABLE imports ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_imports_tenant ON imports(tenant_id, id DESC);
ALTER TABLE automation_rules ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_automation_rules_tenant ON automation_rules(tenant_id, priority ASC, id ASC);
ALTER TABLE automation_events ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_automation_events_tenant_ts ON automation_events(tenant_id, ts DESC);

CREATE TABLE automation_contacts_new (
  tenant_id INTEGER NOT NULL DEFAULT 1,
  ig_id TEXT NOT NULL,
  username TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_rule_hits TEXT,
  PRIMARY KEY (tenant_id, ig_id)
);
INSERT INTO automation_contacts_new (tenant_id, ig_id, username, first_seen, last_seen, message_count, last_rule_hits)
  SELECT 1, ig_id, username, first_seen, last_seen, message_count, last_rule_hits FROM automation_contacts;
DROP TABLE automation_contacts;
ALTER TABLE automation_contacts_new RENAME TO automation_contacts;
CREATE INDEX IF NOT EXISTS idx_automation_contacts_seen ON automation_contacts(tenant_id, last_seen DESC);

CREATE TABLE settings_new (
  tenant_id INTEGER NOT NULL DEFAULT 1,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
INSERT INTO settings_new (tenant_id, key, value, updated_at) SELECT 1, key, value, updated_at FROM settings;
DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;

CREATE TABLE meta_new (
  tenant_id INTEGER NOT NULL DEFAULT 1,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (tenant_id, key)
);
INSERT INTO meta_new (tenant_id, key, value)
  SELECT CASE WHEN key IN ('worker_paused', 'worker_concurrency', 'worker_pause_reason') THEN 0 ELSE 1 END, key, value FROM meta;
DROP TABLE meta;
ALTER TABLE meta_new RENAME TO meta;

DROP TABLE IF EXISTS items_fts;
CREATE VIRTUAL TABLE items_fts USING fts5(
  item_id UNINDEXED, tenant_id UNINDEXED, title, summary, key_points, tags, caption, transcript, author, entities,
  tokenize = 'unicode61 remove_diacritics 2'
);
`,
    after: (d) => {
      insertOwnerUser(d);
      const n = reindexAll();
      if (n) console.log(`[migrate] rebuilt the search index for ${n} saves (multi-tenant schema)`);
    },
  },
];

function migrate(d: DB) {
  d.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const applied = new Set<number>(d.prepare('SELECT id FROM schema_migrations').all().map((r: any) => r.id));
  const run = d.transaction((m: Migration) => {
    d.exec(m.sql);
    if (m.after) m.after(d);
    d.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, Date.now());
  });
  for (const m of MIGRATIONS) if (!applied.has(m.id)) run(m);
  for (const m of [...EXTRA_MIGRATIONS].sort((a, b) => a.id - b.id)) if (!applied.has(m.id)) run(m as Migration);
}

/** Owner login email: APP_USERNAME if it looks like an email, else `${APP_USERNAME}@local`. */
export function ownerEmail(): string | null {
  const u = config.appUsername.trim();
  if (!u) return null;
  return u.includes('@') ? u.toLowerCase() : `${u.toLowerCase()}@local`;
}

function insertOwnerUser(d: DB) {
  const email = ownerEmail();
  if (!email) return;
  const exists = d.prepare('SELECT id FROM users WHERE tenant_id = 1 AND is_owner = 1').get();
  if (exists) return;
  d.prepare('INSERT OR IGNORE INTO users (tenant_id, email, password_hash, is_owner, created_at) VALUES (1, ?, NULL, 1, ?)').run(email, Math.floor(Date.now() / 1000));
}

/** APP_USERNAME may be set (or changed) after the migration ran — keep the owner user row in sync (idempotent). */
function ensureOwnerUser(d: DB) {
  const email = ownerEmail();
  if (!email) return;
  try {
    const cur = d.prepare('SELECT id, email FROM users WHERE tenant_id = 1 AND is_owner = 1').get() as { id: number; email: string } | undefined;
    if (!cur) { insertOwnerUser(d); return; }
    if (cur.email.toLowerCase() === email) return;
    // APP_USERNAME changed to an email that a hosted signup already uses (the operator signed up with their own address).
    // If that account is still empty, fold it into the owner workspace: the user row (and its password) becomes the owner
    // user of tenant 1 and the empty tenant is soft-deleted. If it has data, keep both and say so.
    const taken = d.prepare('SELECT id, tenant_id FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(email, cur.id) as { id: number; tenant_id: number } | undefined;
    if (taken) {
      const items = (d.prepare('SELECT COUNT(*) AS n FROM items WHERE tenant_id = ?').get(taken.tenant_id) as { n: number }).n;
      if (taken.tenant_id !== 1 && items > 0) {
        console.warn(`[db] owner email ${email} belongs to tenant ${taken.tenant_id} which has ${items} saves — not merging; owner login keeps ${cur.email}. Delete that account (Billing → Delete account) to complete the switch.`);
        return;
      }
      d.transaction(() => {
        d.prepare('DELETE FROM users WHERE id = ?').run(cur.id);
        d.prepare('UPDATE users SET tenant_id = 1, is_owner = 1 WHERE id = ?').run(taken.id);
        if (taken.tenant_id !== 1) d.prepare('UPDATE tenants SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), taken.tenant_id);
      })();
      console.log(`[db] merged hosted account ${email} (tenant ${taken.tenant_id}, empty) into the owner workspace`);
      return;
    }
    d.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, cur.id);
  } catch (e) { console.warn('[db] could not sync owner user', e); }
}

export const now = () => Math.floor(Date.now() / 1000);

/* ---------------- meta / settings (always tenant-scoped; tid 0 = global) ---------------- */

export function getMeta(tid: number, key: string): string | null {
  const r = db().prepare('SELECT value FROM meta WHERE tenant_id = ? AND key = ?').get(tid, key) as { value: string } | undefined;
  return r?.value ?? null;
}
export function setMeta(tid: number, key: string, value: string | null) {
  if (value === null) db().prepare('DELETE FROM meta WHERE tenant_id = ? AND key = ?').run(tid, key);
  else db().prepare('INSERT INTO meta (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value').run(tid, key, value);
}

export function getSetting(tid: number, key: string): string | null {
  const r = db().prepare('SELECT value FROM settings WHERE tenant_id = ? AND key = ?').get(tid, key) as { value: string } | undefined;
  return r?.value ?? null;
}
export function setSetting(tid: number, key: string, value: string | null) {
  if (value === null || value === '') db().prepare('DELETE FROM settings WHERE tenant_id = ? AND key = ?').run(tid, key);
  else db().prepare('INSERT INTO settings (tenant_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(tid, key, value, now());
}
export function allSettings(tid: number): Record<string, string> {
  const rows = db().prepare('SELECT key, value FROM settings WHERE tenant_id = ?').all(tid) as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Parse JSON safely. */
export function j<T = any>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
