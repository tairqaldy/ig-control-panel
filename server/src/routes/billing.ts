import { Hono } from 'hono';
import { config } from '../config.js';
import { clearSessionCookie, currentTenant, invalidateSessions } from '../auth.js';
import { db, now } from '../db.js';
import { getTenant, planCatalog, planPayload } from '../services/plans.js';
import { createPortalSession, handlePaddleEvent, verifyPaddleSignature } from '../services/paddle.js';
import { removeItemMedia } from '../services/media.js';
import { dropTenantEmbeddings } from '../services/neighbors.js';

/* ---------------- public: price catalog for the landing/pricing page ---------------- */
export const publicPlans = new Hono();
publicPlans.get('/', (c) => c.json(planCatalog()));

/* ---------------- public: Paddle webhook ---------------- */
export const paddleWebhook = new Hono();
paddleWebhook.post('/', async (c) => {
  const raw = await c.req.text();
  const v = verifyPaddleSignature(raw, c.req.header('paddle-signature'));
  if (!v.ok) {
    console.warn(`[paddle] webhook rejected: ${v.reason}`);
    return c.json({ error: v.reason }, 401);
  }
  let evt: any;
  try { evt = JSON.parse(raw); } catch { return c.json({ error: 'bad json' }, 400); }
  try {
    const r = await handlePaddleEvent(evt);
    console.log(`[paddle] ${r.note}`);
    return c.json({ ok: true, handled: r.handled });
  } catch (e: any) {
    console.error('[paddle] webhook error', e);
    return c.json({ error: String(e?.message || e) }, 500);
  }
});

/* ---------------- auth: plan + account ---------------- */
export const account = new Hono();

account.get('/plan', (c) => c.json(planPayload(currentTenant(c)!.tid)));

/** Delete the current (non-owner) tenant: wipe items + media, automations, settings, usage; mark the tenant deleted; clear the cookie. */
account.delete('/account', async (c) => {
  const s = currentTenant(c)!;
  if (s.isOwner) return c.json({ error: 'The owner account cannot be deleted from here.' }, 403);
  const t = getTenant(s.tid);
  if (!t) return c.json({ error: 'not found' }, 404);
  const d = db();
  const ids = (d.prepare('SELECT id FROM items WHERE tenant_id = ?').all(s.tid) as Array<{ id: string }>).map((r) => r.id);
  d.transaction(() => {
    d.prepare('DELETE FROM items_fts WHERE tenant_id = ?').run(s.tid);
    d.prepare('DELETE FROM items WHERE tenant_id = ?').run(s.tid); // item_tags / item_neighbors cascade
    d.prepare('DELETE FROM imports WHERE tenant_id = ?').run(s.tid);
    d.prepare('DELETE FROM automation_rules WHERE tenant_id = ?').run(s.tid);
    d.prepare('DELETE FROM automation_events WHERE tenant_id = ?').run(s.tid);
    d.prepare('DELETE FROM automation_contacts WHERE tenant_id = ?').run(s.tid);
    d.prepare('DELETE FROM settings WHERE tenant_id = ?').run(s.tid);
    d.prepare('DELETE FROM meta WHERE tenant_id = ?').run(s.tid);
    d.prepare('DELETE FROM usage WHERE tenant_id = ?').run(s.tid);
    d.prepare('DELETE FROM users WHERE tenant_id = ?').run(s.tid); // frees the email for a future signup
    d.prepare("UPDATE tenants SET deleted_at = ?, updated_at = ?, name = NULL, plan_status = CASE WHEN plan IN ('pro','studio') THEN 'canceled' ELSE plan_status END WHERE id = ?").run(now(), now(), s.tid);
  })();
  dropTenantEmbeddings(s.tid);
  invalidateSessions(s.tid);
  clearSessionCookie(c);
  // media removal can take a while for big libraries — do it in the background
  (async () => { for (const id of ids) { try { await removeItemMedia(id); } catch {} } })();
  return c.json({ ok: true, deletedItems: ids.length, note: t.paddle_subscription_id ? 'Your subscription (if any) must be cancelled in the Paddle customer portal; it is not cancelled automatically.' : undefined });
});

/* ---------------- auth: billing ---------------- */
export const billing = new Hono();

/** Customer portal (manage subscription, payment method, invoices). */
billing.post('/portal', async (c) => {
  const s = currentTenant(c)!;
  const t = getTenant(s.tid);
  if (!config.paddle.apiKey) return c.json({ error: 'Billing is not configured on this server.' }, 503);
  if (!t?.paddle_customer_id) return c.json({ error: 'No billing customer yet — subscribe first.' }, 404);
  try {
    const r = await createPortalSession(t.paddle_customer_id, t.paddle_subscription_id ? [t.paddle_subscription_id] : []);
    return c.json(r);
  } catch (e: any) {
    return c.json({ error: String(e?.message || e) }, 502);
  }
});
