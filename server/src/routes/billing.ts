import { Hono } from 'hono';
import { config } from '../config.js';
import { clearSessionCookie, currentTenant, invalidateSessions } from '../auth.js';
import { db, now } from '../db.js';
import { getTenant, paddlePublic, planCatalog, planPayload } from '../services/plans.js';
import { creditsPayload } from '../services/credits.js';
import { cancelSubscription, createPortalSession, handlePaddleEvent, verifyPaddleSignature } from '../services/paddle.js';
import { removeMediaInBackground } from '../services/media.js';
import { dropTenantEmbeddings } from '../services/neighbors.js';
import { disconnect } from '../services/instagram.js';

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
    // `retry` means we could not attach the event to an account — a paid person still locked out. 503 buys Paddle's
    // three days of retries; a 200 here would drop the only chance to recover without hand-written SQL.
    if (r.retry) { console.error(`[paddle] UNRESOLVED EVENT ${evt?.event_id} (${evt?.event_type}) — retrying`); return c.json({ ok: false, handled: false, retry: true }, 503); }
    return c.json({ ok: true, handled: r.handled });
  } catch (e: any) {
    console.error('[paddle] webhook error', e);
    return c.json({ error: String(e?.message || e) }, 500);
  }
});

/* ---------------- auth: plan + account ---------------- */
export const account = new Hono();

account.get('/plan', (c) => c.json(planPayload(currentTenant(c)!.tid)));

/** Delete the current (non-owner) tenant: disconnect Instagram, wipe items + media, automations, conversations, companion
 *  devices, settings, usage; mark the tenant deleted; clear the cookie. Kept in step with /data-deletion and /security. */
account.delete('/account', async (c) => {
  const s = currentTenant(c)!;
  if (s.isOwner) return c.json({ error: 'The owner account cannot be deleted from here.' }, 403);
  const t = getTenant(s.tid);
  if (!t) return c.json({ error: 'not found' }, 404);
  const d = db();
  const ids = (d.prepare('SELECT id FROM items WHERE tenant_id = ?').all(s.tid) as Array<{ id: string }>).map((r) => r.id);
  // Stop the money first. The Billing screen and /data-deletion both have to be able to say something true about the
  // subscription, and after this handler there is no account left to log into and cancel from — so we cancel at
  // Paddle here and report the real outcome rather than leaving a live subscription billing a deleted account.
  const sub = t.paddle_subscription_id;
  const cancel = sub ? await cancelSubscription(sub) : { ok: true, error: null };
  // The Instagram side has to go first and out of band: it unsubscribes the webhook at Meta and deletes the encrypted
  // token, the analytics cache and the automation contacts/events. Without it, deleting the account would leave a live
  // token behind — which is not what /data-deletion and /security promise.
  await disconnect(s.tid, { unsubscribe: true, wipe: true, reason: 'account deleted' });
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
    d.prepare('DELETE FROM companion_devices WHERE tenant_id = ?').run(s.tid); // token hashes + any encrypted IG session
    d.prepare('DELETE FROM harvest_runs WHERE tenant_id = ?').run(s.tid);
    d.prepare('DELETE FROM conversations WHERE tenant_id = ?').run(s.tid); // messages cascade (FKs are on)
    d.prepare('DELETE FROM profile_goals WHERE tenant_id = ?').run(s.tid);
    d.prepare('DELETE FROM profile_scores WHERE tenant_id = ?').run(s.tid);
    d.prepare('DELETE FROM ig_waitlist WHERE tenant_id = ?').run(s.tid); // holds an e-mail address
    d.prepare('DELETE FROM users WHERE tenant_id = ?').run(s.tid); // frees the email for a future signup
    d.prepare("UPDATE tenants SET deleted_at = ?, updated_at = ?, name = NULL, plan_status = CASE WHEN plan IN ('pro','studio') THEN 'canceled' ELSE plan_status END WHERE id = ?").run(now(), now(), s.tid);
  })();
  dropTenantEmbeddings(s.tid);
  invalidateSessions(s.tid);
  clearSessionCookie(c);
  // media removal can take a while for big libraries — do it in the background
  // Media removal can take a while for a big library, so it runs after the response — but a redeploy or a crash
  // mid-loop would leave files on disk with no row left to find them by, and /data-deletion promises those files go.
  // The leftovers are therefore recorded, and the boot sweep in services/media.ts finishes the job.
  void removeMediaInBackground(ids, s.tid);
  return c.json({
    ok: true,
    deletedItems: ids.length,
    subscription: sub ? (cancel.ok ? 'canceled' : 'cancel_failed') : 'none',
    note: !sub
      ? undefined
      : cancel.ok
        ? 'Your subscription has been cancelled at Paddle; nothing further will be charged.'
        : `We could not cancel your subscription at Paddle (${cancel.error}). Write to hello@resurfly.com and we will cancel it by hand — you will not be charged for the period after that.`,
  });
});

/* ---------------- auth: billing ---------------- */
export const billing = new Hono();

/**
 * Balance, ledger and the pack catalogue for the Billing page. Same `credits` block as `GET /api/plan`, with a longer
 * ledger, plus what Paddle.js needs to open the one-time checkout for a pack.
 */
billing.get('/credits', (c) => {
  const s = currentTenant(c)!;
  return c.json({ ...creditsPayload(s.tid, 50), paddle: { ...paddlePublic(), customData: { tenant_id: s.tid } } });
});

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
