/**
 * Paddle Billing (hosted mode): webhook verification + event handling, customer portal sessions.
 * Checkout itself is client-side (Paddle.js overlay) — the server only hands out the client token, price ids and
 * `customData: { tenant_id }` (see plans.planPayload) and then reacts to webhooks here.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, getMeta, GLOBAL, j, now, setMeta } from '../db.js';
import type { PlanStatus, TenantRow } from '../types.js';
import { getTenant, planForPriceId, updateTenant } from './plans.js';

export function paddleApiBase(): string {
  return config.paddle.env === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
}

/* ---------------- webhook signature ---------------- */

/**
 * `Paddle-Signature: ts=1671552777;h1=eb4d0dc8...` — HMAC-SHA256 (hex) over `${ts}:${rawBody}` with the endpoint secret.
 * Multiple `h1` values may be present during secret rotation; any match is accepted. Rejects timestamps older/newer than 5 minutes.
 */
export function verifyPaddleSignature(rawBody: string, header: string | undefined, secret = config.paddle.webhookSecret, nowMs = Date.now()): { ok: boolean; reason?: string } {
  if (!secret) return { ok: false, reason: 'PADDLE_WEBHOOK_SECRET not configured' };
  if (!header) return { ok: false, reason: 'missing Paddle-Signature header' };
  let ts = '';
  const h1: string[] = [];
  for (const part of header.split(';')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    if (k === 'ts') ts = v || '';
    else if (k === 'h1' && v) h1.push(v);
  }
  if (!ts || !h1.length) return { ok: false, reason: 'malformed Paddle-Signature header' };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(nowMs / 1000 - tsNum) > 300) return { ok: false, reason: 'timestamp outside the 5 minute window' };
  const expected = crypto.createHmac('sha256', secret).update(`${ts}:${rawBody}`, 'utf8').digest('hex');
  const eb = Buffer.from(expected);
  for (const sig of h1) {
    const sb = Buffer.from(sig);
    if (sb.length === eb.length && crypto.timingSafeEqual(sb, eb)) return { ok: true };
  }
  return { ok: false, reason: 'signature mismatch' };
}

/* ---------------- idempotency: last 500 event ids in meta (tenant 0) ---------------- */
const EVENTS_KEY = 'paddle_events';
function seenEvent(eventId: string): boolean {
  const ids = j<string[]>(getMeta(GLOBAL, EVENTS_KEY), []);
  return ids.includes(eventId);
}
function rememberEvent(eventId: string) {
  const ids = j<string[]>(getMeta(GLOBAL, EVENTS_KEY), []);
  ids.push(eventId);
  while (ids.length > 500) ids.shift();
  setMeta(GLOBAL, EVENTS_KEY, JSON.stringify(ids));
}

/* ---------------- event handling ---------------- */

export interface PaddleEvent {
  event_id: string;
  event_type: string;
  occurred_at?: string;
  data: any;
}

const HANDLED = new Set([
  'subscription.created', 'subscription.updated', 'subscription.activated', 'subscription.canceled', 'subscription.past_due', 'subscription.paused', 'subscription.resumed',
  'transaction.completed',
]);

const iso = (s: unknown): number | null => { if (typeof s !== 'string' || !s) return null; const t = Date.parse(s); return Number.isFinite(t) ? Math.floor(t / 1000) : null; };

function mapStatus(s: unknown): PlanStatus | null {
  switch (s) {
    case 'active': case 'trialing': return 'active';
    case 'past_due': return 'past_due';
    case 'paused': return 'paused';
    case 'canceled': return 'canceled';
    default: return null;
  }
}

/** Resolve the tenant an event refers to: custom_data.tenant_id (set at checkout) → known subscription id → known customer id → customer email (API). */
async function resolveTenant(data: any): Promise<TenantRow | undefined> {
  const raw = data?.custom_data?.tenant_id ?? data?.custom_data?.tenantId;
  const tid = Number(raw);
  if (Number.isInteger(tid) && tid > 0) { const t = getTenant(tid); if (t) return t; }
  const d = db();
  if (data?.subscription_id || (typeof data?.id === 'string' && data.id.startsWith('sub_'))) {
    const sid = data.subscription_id || data.id;
    const t = d.prepare('SELECT * FROM tenants WHERE paddle_subscription_id = ?').get(sid) as TenantRow | undefined;
    if (t) return t;
  }
  if (data?.customer_id) {
    const t = d.prepare('SELECT * FROM tenants WHERE paddle_customer_id = ?').get(data.customer_id) as TenantRow | undefined;
    if (t) return t;
    if (config.paddle.apiKey) {
      try {
        const cust = await paddleApi('GET', `/customers/${encodeURIComponent(data.customer_id)}`);
        const email = String(cust?.data?.email || '').toLowerCase();
        if (email) {
          const u = d.prepare('SELECT tenant_id FROM users WHERE email = ? COLLATE NOCASE').get(email) as { tenant_id: number } | undefined;
          if (u) return getTenant(u.tenant_id);
        }
      } catch (e) { console.warn('[paddle] customer lookup failed', e); }
    }
  }
  return undefined;
}

function firstPriceId(data: any): string | null {
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  for (const it of items) {
    const id = it?.price?.id || it?.price_id;
    if (id && planForPriceId(id)) return id;
  }
  return items[0]?.price?.id || items[0]?.price_id || null;
}

/** Apply one (verified) Paddle event to the tenants table. Returns a short description for logging. */
export async function handlePaddleEvent(evt: PaddleEvent): Promise<{ handled: boolean; note: string; tenantId?: number }> {
  if (!evt?.event_id || !evt.event_type) return { handled: false, note: 'malformed event' };
  if (!HANDLED.has(evt.event_type)) return { handled: false, note: `ignored ${evt.event_type}` };
  if (seenEvent(evt.event_id)) return { handled: true, note: `duplicate ${evt.event_id}` };
  const data = evt.data || {};
  const tenant = await resolveTenant(data);
  if (!tenant) { rememberEvent(evt.event_id); return { handled: false, note: `${evt.event_type}: no tenant for customer ${data.customer_id || '?'}` }; }
  if (tenant.plan === 'owner') { rememberEvent(evt.event_id); return { handled: false, note: 'owner tenant is not billable', tenantId: tenant.id }; }

  const patch: Partial<TenantRow> = {};
  const priceId = firstPriceId(data);
  const plan = planForPriceId(priceId);
  const t = now();

  if (evt.event_type.startsWith('subscription.')) {
    if (typeof data.id === 'string') patch.paddle_subscription_id = data.id;
    if (data.customer_id) patch.paddle_customer_id = data.customer_id;
    if (priceId) patch.paddle_price_id = priceId;
    if (plan) patch.plan = plan;
    const status = evt.event_type === 'subscription.canceled' ? 'canceled' : mapStatus(data.status);
    // A cancel scheduled for the end of the period arrives as subscription.updated with scheduled_change.action = 'cancel'.
    const scheduledCancel = data?.scheduled_change?.action === 'cancel';
    if (scheduledCancel) { patch.plan_status = 'canceled'; patch.cancelled_at = tenant.cancelled_at || t; }
    else if (status) {
      patch.plan_status = status;
      if (status === 'canceled') patch.cancelled_at = iso(data.canceled_at) || tenant.cancelled_at || t;
      else patch.cancelled_at = null; // resumed / re-activated / un-cancelled
    }
    const periodEnd = iso(data?.current_billing_period?.ends_at);
    if (periodEnd) patch.plan_renews_at = periodEnd;
    else if (status === 'canceled' && !tenant.plan_renews_at) patch.plan_renews_at = t; // no period info: grace starts now
    const started = iso(data.started_at) || iso(data.first_billed_at);
    if (started && (!tenant.plan_started_at || evt.event_type === 'subscription.created' || evt.event_type === 'subscription.activated')) patch.plan_started_at = started;
    if (!patch.plan_started_at && !tenant.plan_started_at && plan) patch.plan_started_at = t;
  } else if (evt.event_type === 'transaction.completed') {
    // A successful payment: (re)activate, extend the period, remember ids.
    if (data.customer_id) patch.paddle_customer_id = data.customer_id;
    if (data.subscription_id) patch.paddle_subscription_id = data.subscription_id;
    if (priceId) patch.paddle_price_id = priceId;
    if (plan) patch.plan = plan;
    if (data.subscription_id || plan) patch.plan_status = 'active';
    if (plan && !tenant.plan_started_at) patch.plan_started_at = t;
    const periodEnd = iso(data?.billing_period?.ends_at) || iso(data?.items?.[0]?.proration?.billing_period?.ends_at);
    if (periodEnd) patch.plan_renews_at = periodEnd;
    if (tenant.plan_status === 'past_due' || tenant.plan_status === 'paused') patch.cancelled_at = null;
  }

  // Never let a plan we can't map wipe a paid plan; unknown price ids keep the current plan.
  if (Object.keys(patch).length) updateTenant(tenant.id, patch);
  rememberEvent(evt.event_id);
  return { handled: true, note: `${evt.event_type} → tenant ${tenant.id} ${JSON.stringify({ plan: patch.plan, status: patch.plan_status })}`, tenantId: tenant.id };
}

/* ---------------- Paddle API ---------------- */

export async function paddleApi(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
  if (!config.paddle.apiKey) throw new Error('PADDLE_API_KEY not configured');
  const res = await fetch(`${paddleApiBase()}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.paddle.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`Paddle API ${method} ${path}: HTTP ${res.status} ${data?.error?.detail || data?.error?.code || text.slice(0, 200)}`);
  return data;
}

/** Customer portal session → URL the customer can open to manage/cancel the subscription and see invoices. */
export async function createPortalSession(customerId: string, subscriptionIds: string[] = []): Promise<{ url: string; cancelUrl: string | null; paymentMethodUrl: string | null }> {
  const res = await paddleApi('POST', `/customers/${encodeURIComponent(customerId)}/portal-sessions`, subscriptionIds.length ? { subscription_ids: subscriptionIds } : {});
  const urls = res?.data?.urls || {};
  const sub = Array.isArray(urls.subscriptions) ? urls.subscriptions[0] : null;
  const url = urls?.general?.overview || sub?.update_subscription_payment_method || null;
  if (!url) throw new Error('Paddle did not return a portal URL');
  return { url, cancelUrl: sub?.cancel_subscription || null, paymentMethodUrl: sub?.update_subscription_payment_method || null };
}
