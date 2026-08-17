/**
 * Extra migrations, one file per feature, so parallel work doesn't collide inside db.ts.
 * Append your migration to EXTRA_MIGRATIONS (ids must be > 3 and unique; keep the array sorted by id).
 * Shape is the same as db.ts `Migration`: { id, sql, after?(d) }.
 */
import type Database from 'better-sqlite3';
import { migration004Instagram } from './004-instagram.js';
import { migration005Companion } from './005-companion.js';
import { migration006 } from './006-ask-onboarding.js';
import { migration007Automations } from './007-automations.js';
import { migration008Credits } from './008-credits.js';

export interface ExtraMigration { id: number; sql: string; after?: (d: Database.Database) => void }

export const EXTRA_MIGRATIONS: ExtraMigration[] = [
  migration004Instagram, // 4: instagram connect + analytics (server-instagram agent) → ./004-instagram.ts
  migration005Companion, // 5: companion devices + server-side harvest (server-companion agent) → ./005-companion.ts
  migration006, // 6: ask conversations + onboarding state (server-ask agent) → ./006-ask-onboarding.ts
  migration007Automations, // 7: rule post filter + once-per-person + last send error (server-automations agent) → ./007-automations.ts
  migration008Credits, // 8: tenants.credits + credit_ledger (server-credits agent) → ./008-credits.ts
];
