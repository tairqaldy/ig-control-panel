/**
 * Can Instagram be connected right now, and who wants telling when it can? (ROUND7-SPEC §3)
 * Mounted at /api/instagram with one line in ./extra.ts.
 *
 *   GET    /api/instagram/availability   — { canConnect, mode, reason, waitlist, … }; add ?refresh=1 to re-probe Meta
 *   POST   /api/instagram/waitlist       — record interest (defaults to the account's own e-mail), idempotent
 *   DELETE /api/instagram/waitlist       — take them off again
 *   GET    /api/instagram/waitlist/pending — owner only: everyone still to be told
 *
 * Onboarding, Automations and Analytics read `availability` before they offer a Connect button, so nobody is sent
 * at a door that cannot open.
 */
import { Hono } from 'hono';
import { currentTenant, tid } from '../auth.js';
import { db } from '../db.js';
import { igAvailability, waitlistAdd, waitlistAll, waitlistRemove, waitlistRow } from '../services/ig-availability.js';

export const instagramAvailability = new Hono();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** The address we already have for this tenant: the owner user of the account, else the session's login name. */
function accountEmail(t: number, sessionUser: string | null): string | null {
  try {
    const r = db().prepare('SELECT email FROM users WHERE tenant_id = ? ORDER BY is_owner DESC, id ASC LIMIT 1').get(t) as { email?: string } | undefined;
    if (r?.email && EMAIL_RE.test(r.email)) return r.email;
  } catch {}
  return sessionUser && EMAIL_RE.test(sessionUser) ? sessionUser : null;
}

instagramAvailability.get('/availability', async (c) => {
  return c.json(await igAvailability(tid(c), { force: c.req.query('refresh') === '1' }));
});

instagramAvailability.post('/waitlist', async (c) => {
  const s = currentTenant(c)!;
  const body = await c.req.json<{ email?: string; source?: string }>().catch(() => ({} as { email?: string; source?: string }));
  const given = String(body.email || '').trim().slice(0, 254);
  if (given && !EMAIL_RE.test(given)) return c.json({ ok: false, error: 'That does not look like an e-mail address.', code: 'bad_email' }, 400);
  const email = given || accountEmail(s.tid, s.u);
  if (!email) return c.json({ ok: false, error: 'We have no e-mail address for this account — send us one to write to.', code: 'no_email' }, 400);

  const { row, alreadyOn } = waitlistAdd(s.tid, email, String(body.source || '').slice(0, 60) || null);
  return c.json({
    ok: true,
    waitlist: true,
    alreadyOn,
    email: row.email,
    createdAt: row.created_at,
    message: alreadyOn ? `You're already on the list — we'll write to ${row.email}.` : `Noted. We'll write to ${row.email} the day Instagram connections open.`,
  });
});

instagramAvailability.get('/waitlist', (c) => {
  const row = waitlistRow(tid(c));
  return c.json({ waitlist: !!row, email: row?.email ?? null, createdAt: row?.created_at ?? null, notifiedAt: row?.notified_at ?? null });
});

instagramAvailability.delete('/waitlist', (c) => {
  const removed = waitlistRemove(tid(c));
  return c.json({ ok: true, waitlist: false, removed });
});

/**
 * Owner-only, oldest first: the addresses the "Instagram connections are open" e-mail goes to. Promising to write to
 * people is only honest if the list can actually be read. `isOwner` is the deployment's own admin login, never a
 * tenant's owner user, so no customer can read another customer's address here.
 */
instagramAvailability.get('/waitlist/pending', (c) => {
  if (!currentTenant(c)?.isOwner) return c.json({ error: 'Owner only.' }, 403);
  const rows = waitlistAll(2000);
  return c.json({ count: rows.length, waiting: rows.map((r) => ({ tenantId: r.tenant_id, email: r.email, source: r.source, createdAt: r.created_at })) });
});
