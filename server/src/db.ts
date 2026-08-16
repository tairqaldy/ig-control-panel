import Database from 'better-sqlite3';
import { config } from './config.js';

export type DB = Database.Database;

let _db: DB | null = null;

export function db(): DB {
  if (_db) return _db;
  const d = new Database(config.dbPath);
  d.pragma('journal_mode = WAL');
  d.pragma('synchronous = NORMAL');
  d.pragma('foreign_keys = ON');
  d.pragma('busy_timeout = 5000');
  migrate(d);
  _db = d;
  return d;
}

const MIGRATIONS: { id: number; sql: string }[] = [
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
];

function migrate(d: DB) {
  d.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const applied = new Set<number>(d.prepare('SELECT id FROM schema_migrations').all().map((r: any) => r.id));
  const run = d.transaction((m: { id: number; sql: string }) => {
    d.exec(m.sql);
    d.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, Date.now());
  });
  for (const m of MIGRATIONS) if (!applied.has(m.id)) run(m);
}

export const now = () => Math.floor(Date.now() / 1000);

export function getMeta(key: string): string | null {
  const r = db().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
export function setMeta(key: string, value: string | null) {
  if (value === null) db().prepare('DELETE FROM meta WHERE key = ?').run(key);
  else db().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function getSetting(key: string): string | null {
  const r = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
export function setSetting(key: string, value: string | null) {
  if (value === null || value === '') db().prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db().prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, value, now());
}
export function allSettings(): Record<string, string> {
  const rows = db().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Parse JSON safely. */
export function j<T = any>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
