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
import { migration009Paywall } from './009-paywall.js';
import { migration010ProfileScore } from './010-profile-score.js';
import { migration011IgWaitlist } from './011-ig-waitlist.js';

export interface ExtraMigration { id: number; sql: string; after?: (d: Database.Database) => void }

export const EXTRA_MIGRATIONS: ExtraMigration[] = [
  migration004Instagram, // 4: instagram connect + analytics (server-instagram agent) → ./004-instagram.ts
  migration005Companion, // 5: companion devices + server-side harvest (server-companion agent) → ./005-companion.ts
  migration006, // 6: ask conversations + onboarding state (server-ask agent) → ./006-ask-onboarding.ts
  migration007Automations, // 7: rule post filter + once-per-person + last send error (server-automations agent) → ./007-automations.ts
  migration008Credits, // 8: tenants.credits + credit_ledger (server-credits agent) → ./008-credits.ts
  migration009Paywall, // 9: tenants.requires_payment + paywall_cleared_at, existing tenants grandfathered (server-paywall agent) → ./009-paywall.ts
  migration010ProfileScore, // 10: profile_goals + profile_scores (server-profile-score agent) → ./010-profile-score.ts
  migration011IgWaitlist, // 11: ig_waitlist — tell me when Instagram connections open (server-instagram-availability agent) → ./011-ig-waitlist.ts
];
