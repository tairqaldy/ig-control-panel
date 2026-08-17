/**
 * Migration 8 — credits (ROUND6-SPEC §3, server-credits agent).
 *
 * `tenants.credits` is the current balance; `credit_ledger` is the append-only history (one row per grant, purchase
 * or spend) so the balance can always be explained. Credits are only spent after the plan allowance is used up.
 *
 * The partial unique index on (tenant_id, ref) for positive deltas is what makes a Paddle credit purchase idempotent:
 * the same Paddle transaction id can never be credited twice, even if the webhook is delivered again under a new event id.
 */
import type { ExtraMigration } from './index.js';

export const migration008Credits: ExtraMigration = {
  id: 8,
  sql: `
CREATE TABLE IF NOT EXISTS credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_tenant ON credit_ledger(tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_grant_ref ON credit_ledger(tenant_id, ref) WHERE ref IS NOT NULL AND delta > 0;
`,
  after: (d) => {
    const cols = d.prepare('PRAGMA table_info(tenants)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'credits')) d.exec('ALTER TABLE tenants ADD COLUMN credits INTEGER NOT NULL DEFAULT 0');
  },
};
