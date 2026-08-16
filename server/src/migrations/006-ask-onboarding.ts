/**
 * Migration 6 — Ask v2 conversations + onboarding state (server-ask agent, ROUND5-SPEC §6/§7).
 *
 * Tables: `conversations`, `messages` (per tenant, cascade delete).
 * Onboarding needs NO table: it lives in `meta` (tenant-scoped) under these keys (all values '1' or an epoch string):
 *   onboarding_explored      – the user opened Library or Graph          (POST /api/onboarding/event {key:'explored'})
 *   onboarding_dismissed     – the checklist / welcome flow was dismissed (key:'dismissed')
 *   onboarding_asked         – the user asked something in Ask           (key:'asked'; also set by POST /api/ask)
 *   onboarding_welcome_seen  – the /welcome flow was shown once           (key:'welcome_seen')
 */
import type { ExtraMigration } from './index.js';

export const ONBOARDING_META_KEYS = {
  explored: 'onboarding_explored',
  dismissed: 'onboarding_dismissed',
  asked: 'onboarding_asked',
  welcome_seen: 'onboarding_welcome_seen',
} as const;

export const migration006: ExtraMigration = {
  id: 6,
  sql: `
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant_updated ON conversations(tenant_id, pinned DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL DEFAULT '',
  sources TEXT,
  intent TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id ASC);
`,
};
