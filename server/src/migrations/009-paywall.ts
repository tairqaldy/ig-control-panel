/**
 * Migration 9 — the signup paywall (ROUND7-SPEC §1, server-paywall agent). Registered in ./index.ts.
 *
 * `requires_payment = 1` means "this account has not put a card on file yet and is locked out of the app".
 * `paywall_cleared_at` remembers when a card arrived (subscription or credit pack), so support can tell a
 * grandfathered account (never required, cleared_at NULL) from a paying one.
 *
 * THE IMPORTANT PART: every tenant that already exists when this runs is backfilled to 0. People who signed up under
 * the old rules keep the product they signed up for and must never meet a wall. Only signups made after the flag is
 * switched on get a 1 (see routes/auth.ts). The backfill is written explicitly instead of relying on the column
 * default so the intent survives a future schema change, and the cut-off is recorded in meta for support.
 */
import type { ExtraMigration } from './index.js';

export const migration009Paywall: ExtraMigration = {
  id: 9,
  sql: '',
  after: (d) => {
    const cols = (d.prepare('PRAGMA table_info(tenants)').all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('requires_payment')) d.exec('ALTER TABLE tenants ADD COLUMN requires_payment INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('paywall_cleared_at')) d.exec('ALTER TABLE tenants ADD COLUMN paywall_cleared_at INTEGER');

    // Grandfathering: nobody who is already here gets locked out.
    const grandfathered = d.prepare('UPDATE tenants SET requires_payment = 0 WHERE requires_payment != 0').run().changes;
    const maxId = (d.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM tenants').get() as { n: number }).n;
    d.prepare('INSERT INTO meta (tenant_id, key, value) VALUES (0, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value')
      .run('paywall_grandfathered_through_tenant', String(maxId));
    console.log(`[migrate] paywall: tenants 1..${maxId} are grandfathered (never asked for a card)${grandfathered ? `, ${grandfathered} row(s) reset` : ''}`);
  },
};
