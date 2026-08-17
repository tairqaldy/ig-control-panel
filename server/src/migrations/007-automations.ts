/**
 * Migration 7 — automation rules gain a post filter, a once-per-person switch and a place to remember the last send error.
 * Registered in ./index.ts. Owned by the server-automations work (round 6, spec §1).
 *
 * `media_ids` holds a JSON array of Instagram media ids ("only run on these posts"); NULL or `[]` means every post.
 * The post picker reads the round-5 `ig_media` table — no second media table is created here.
 */
import type { ExtraMigration } from './index.js';

export const migration007Automations: ExtraMigration = {
  id: 7,
  sql: `
ALTER TABLE automation_rules ADD COLUMN media_ids TEXT;
ALTER TABLE automation_rules ADD COLUMN once_per_person INTEGER NOT NULL DEFAULT 0;
ALTER TABLE automation_rules ADD COLUMN last_error TEXT;
ALTER TABLE automation_rules ADD COLUMN last_error_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_automation_events_tenant_dir ON automation_events(tenant_id, direction, ts DESC);
`,
};
