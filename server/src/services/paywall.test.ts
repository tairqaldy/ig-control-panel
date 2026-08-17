/**
 * In-process test for the signup paywall (ROUND7-SPEC §1). No ports, no network: the app is driven with `app.request`.
 *
 *   npx tsx server/src/services/paywall.test.ts
 *
 * Runs against a COPY of ./data when there is one, so migration 009 meets a real database and the grandfathering
 * claim — "nobody who is already here gets locked out" — is checked against the tenants that actually exist.
 * Covers: migration + backfill, a new signup locked, the 402 shape and which routes stay open, the Paddle webhook
 * (trialing subscription and credit pack) lifting the lock, and the flag turning itself off when the prices are gone.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..'); // server/src/services → repo root
const SRC = path.join(REPO, 'data');
const DEST = fs.mkdtempSync(path.join(os.tmpdir(), 'resurfly-paywall-'));

if (fs.existsSync(SRC)) {
  for (const f of fs.readdirSync(SRC)) {
    const p = path.join(SRC, f);
    if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(DEST, f));
  }
  console.log(`[setup] copied ${SRC} → ${DEST}`);
} else {
  console.log(`[setup] no ./data in this checkout — running against a fresh database at ${DEST}`);
}

/* ---------- env BEFORE importing anything from the server ---------- */
process.env.DATA_DIR = DEST;
process.env.NODE_ENV = 'test';
process.env.AUTO_START_WORKER = 'false';
process.env.SERVER_HARVEST_ENABLED = 'false';
process.env.APP_USERNAME = 'owner@example.com';
process.env.SESSION_SECRET = 'test-session-secret-value-0123456789';
process.env.HOSTED = 'true';
process.env.OPENAI_API_KEY = '';
process.env.META_APP_ID = '';
process.env.META_APP_SECRET = '';
process.env.PADDLE_PRICE_PRO_MONTH = 'pri_pro_month';
process.env.PADDLE_PRICE_PRO_YEAR = 'pri_pro_year';
process.env.PADDLE_PRICE_STUDIO_MONTH = 'pri_studio_month';
process.env.PADDLE_PRICE_STUDIO_YEAR = 'pri_studio_year';
process.env.PADDLE_PRICE_PRO_MONTH_TRIAL = 'pri_pro_month_trial';
process.env.PADDLE_PRICE_PRO_YEAR_TRIAL = 'pri_pro_year_trial';
process.env.PADDLE_PRICE_STUDIO_MONTH_TRIAL = 'pri_studio_month_trial';
process.env.PADDLE_PRICE_STUDIO_YEAR_TRIAL = 'pri_studio_year_trial';
process.env.PADDLE_PRICE_CREDITS_500 = 'pri_credits_500';
process.env.PADDLE_CLIENT_TOKEN = 'test_client_token'; // without it the Paddle overlay cannot open …
process.env.PADDLE_WEBHOOK_SECRET = 'test_webhook_secret'; // … and without this the lock would never lift
process.env.PADDLE_API_KEY = 'test_api_key'; // … and without this there is no portal, so no way to cancel

/* ---------- imports (after env) ---------- */
const mod = (rel: string) => pathToFileURL(path.join(REPO, rel)).href;
const { createApp } = await import(mod('server/src/app.ts'));
const { db, now } = await import(mod('server/src/db.ts'));
const { createSessionToken } = await import(mod('server/src/auth.ts'));
const { migration009Paywall } = await import(mod('server/src/migrations/009-paywall.ts'));
const { paywallGuard } = await import(mod('server/src/routes/paywall.ts'));
const { clearPaywall, missingPaywallConfig, missingTrialPriceIds, paywallEnabled, paywallState, requiresPaymentAtSignup } = await import(mod('server/src/services/paywall.ts'));
const { planCatalog, planForPriceId, planPayload } = await import(mod('server/src/services/plans.ts'));
const { handlePaddleEvent } = await import(mod('server/src/services/paddle.ts'));
const { creditBalance } = await import(mod('server/src/services/credits.ts'));

/* ---------- assert harness ---------- */
let pass = 0; const failures: string[] = [];
function check(name: string, cond: unknown, extra?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra !== undefined ? ` → ${JSON.stringify(extra)}` : ''}`); }
}
const eq = (name: string, actual: unknown, expected: unknown) => check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
const section = (s: string) => console.log(`\n=== ${s} ===`);

const d = db();
const app = createApp();
const get = (p: string, cookie: string) => app.request(p, { headers: { cookie } });
const post = (p: string, body: unknown, cookie: string) => app.request(p, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const tenantOf = (id: number) => d.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as any;

/* ---------- A. migration 009 ---------- */
section('A. migration 009 — schema and grandfathering');
{
  const applied = (d.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as any[]).map((r) => r.id);
  check('migration 9 applied', applied.includes(9), applied);
  const cols = (d.prepare('PRAGMA table_info(tenants)').all() as any[]).map((c) => c.name);
  for (const col of ['requires_payment', 'paywall_cleared_at']) check(`tenants.${col} exists`, cols.includes(col), cols);

  // Every tenant that existed before this test ran (the copied database, plus the owner) must be unlocked forever.
  const before = d.prepare('SELECT id, requires_payment FROM tenants').all() as Array<{ id: number; requires_payment: number }>;
  check(`all ${before.length} pre-existing tenant(s) backfilled to 0`, before.every((t) => Number(t.requires_payment) === 0), before.filter((t) => Number(t.requires_payment) !== 0));
  const marker = d.prepare("SELECT value FROM meta WHERE tenant_id = 0 AND key = 'paywall_grandfathered_through_tenant'").get() as any;
  check('the grandfathering cut-off is recorded in meta', Number(marker?.value) >= 1, marker);

  // Replay the migration against a table that does NOT have the columns yet — the state every existing deploy is in.
  const t = now();
  const legacyId = Number(d.prepare("INSERT INTO tenants (name, plan, plan_status, created_at, updated_at) VALUES ('legacy', 'trial', 'active', ?, ?)").run(t, t).lastInsertRowid);
  try {
    d.exec('ALTER TABLE tenants DROP COLUMN requires_payment');
    d.exec('ALTER TABLE tenants DROP COLUMN paywall_cleared_at');
    d.exec(migration009Paywall.sql);
    migration009Paywall.after!(d);
    const cols2 = (d.prepare('PRAGMA table_info(tenants)').all() as any[]).map((c) => c.name);
    check('re-adding the columns restores the schema', cols2.includes('requires_payment') && cols2.includes('paywall_cleared_at'), cols2);
    eq('a tenant that predates the paywall is not locked', Number(tenantOf(legacyId).requires_payment), 0);
    // Belt and braces: even a row that somehow carries a 1 is reset by the backfill.
    d.prepare('UPDATE tenants SET requires_payment = 1 WHERE id = ?').run(legacyId);
    migration009Paywall.after!(d);
    eq('the backfill resets a stray 1', Number(tenantOf(legacyId).requires_payment), 0);
  } catch (e: any) {
    check('ALTER TABLE ... DROP COLUMN is supported', false, String(e?.message || e));
  }
  eq('the legacy tenant is not locked', paywallState(legacyId).locked, false);
  eq('and says why', paywallState(legacyId).reason, 'not_required');
}

/* ---------- B. the flag ---------- */
section('B. TRIAL_REQUIRES_CARD');
{
  eq('on by default in hosted mode with all four trial prices', paywallEnabled(), true);
  eq('nothing missing', missingTrialPriceIds(), []);
  eq('nothing missing in the rest of the Paddle config either', missingPaywallConfig(), []);
  eq('a signup made now starts locked', requiresPaymentAtSignup(), 1);

  const saved = process.env.PADDLE_PRICE_STUDIO_YEAR_TRIAL;
  delete process.env.PADDLE_PRICE_STUDIO_YEAR_TRIAL;
  eq('one missing price id turns the paywall off', paywallEnabled(), false);
  eq('and names the env var', missingTrialPriceIds(), ['PADDLE_PRICE_STUDIO_YEAR_TRIAL']);
  eq('so a signup during a broken deploy is not locked', requiresPaymentAtSignup(), 0);
  process.env.PADDLE_PRICE_STUDIO_YEAR_TRIAL = saved;
  eq('restoring the id turns it back on', paywallEnabled(), true);

  // Prices alone are not enough to lock somebody out: they also need a way to pay, a way to be let back in, and a
  // way out. PADDLE_API_KEY is the last of those — without it `plan.canManage` is false and the Billing page shows
  // no cancel control at all, while /start, /terms and the upgrade modal all promise "one click, no e-mail".
  for (const key of ['PADDLE_CLIENT_TOKEN', 'PADDLE_WEBHOOK_SECRET', 'PADDLE_API_KEY']) {
    const was = process.env[key];
    delete process.env[key];
    eq(`no ${key} → no paywall`, paywallEnabled(), false);
    eq(`and ${key} is named`, missingPaywallConfig(), [key]);
    process.env[key] = was;
  }
  eq('with the whole config present the paywall is on', paywallEnabled(), true);

  // The public catalog has to carry this, or the landing, pricing, signup and login pages cannot stop saying
  // "no card" — which is the first thing the paywall makes false, and the visitor finds out one click later.
  eq('the public catalog says a card is required', planCatalog().trialRequiresCard, true);
  const savedTok = process.env.PADDLE_CLIENT_TOKEN;
  delete process.env.PADDLE_CLIENT_TOKEN;
  eq('and says it is not when the paywall turned itself off', planCatalog().trialRequiresCard, false);
  process.env.PADDLE_CLIENT_TOKEN = savedTok;
}

/* ---------- C. price ids ---------- */
section('C. price id → plan');
{
  eq('paid pro monthly', planForPriceId('pri_pro_month'), 'pro');
  eq('trial pro monthly maps to the same plan', planForPriceId('pri_pro_month_trial'), 'pro');
  eq('trial studio yearly', planForPriceId('pri_studio_year_trial'), 'studio');
  eq('a credit pack is not a plan', planForPriceId('pri_credits_500'), null);
  eq('an unknown id is not a plan', planForPriceId('pri_nonsense'), null);
}

/* ---------- D. a new signup is locked ---------- */
section('D. new signup → locked');
const email = `paywall-${Date.now()}@example.com`;
let lockedTid = 0;
let lockedCookie = '';
{
  const res = await app.request('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'test-password-1' }) });
  const body = await res.json() as any;
  check('signup succeeded', res.status === 200 && body.ok, { status: res.status, body });
  lockedTid = body.tenantId;
  eq('the signup response says a card is needed', body.requiresPayment, true);
  eq('requires_payment is 1 in the database', Number(tenantOf(lockedTid).requires_payment), 1);
  const uid = (d.prepare('SELECT id FROM users WHERE tenant_id = ?').get(lockedTid) as any).id;
  lockedCookie = `rs_session=${createSessionToken(email, lockedTid, uid)}`;

  eq('paywallState says locked', [paywallState(lockedTid).locked, paywallState(lockedTid).reason], [true, 'no_card']);

  for (const p of ['/api/items', '/api/settings', '/api/onboarding/state']) {
    const r = await get(p, lockedCookie);
    const b = await r.json().catch(() => ({})) as any;
    check(`${p} → 402 payment_required`, r.status === 402 && b.code === 'payment_required', { status: r.status, body: b });
  }
  const one = await get('/api/items', lockedCookie);
  const oneBody = await one.json() as any;
  check('the 402 explains what to do without shouting', typeof oneBody.error === 'string' && /card/i.test(oneBody.error) && oneBody.start === '/start', oneBody);

  for (const p of ['/api/plan', '/api/plans', '/api/paywall', '/api/billing/credits', '/api/auth/me']) {
    const r = await get(p, lockedCookie);
    check(`${p} stays open while locked`, r.status === 200, r.status);
  }
  const out = await post('/api/auth/logout', {}, lockedCookie);
  check('logout stays open while locked', out.status === 200, out.status);

  const pw = await (await get('/api/paywall', lockedCookie)).json() as any;
  eq('GET /api/paywall says locked', [pw.locked, pw.reason], [true, 'no_card']);
  eq('and offers the trial price ids', pw.priceIds, { proMonth: 'pri_pro_month_trial', proYear: 'pri_pro_year_trial', studioMonth: 'pri_studio_month_trial', studioYear: 'pri_studio_year_trial' });
  eq('the paid ids are there too, for a later upgrade', pw.paidPriceIds.proMonth, 'pri_pro_month');
  eq('two plans to choose from', pw.plans.map((p: any) => p.id), ['pro', 'studio']);
  eq('each plan carries its trial price ids', pw.plans[0].trialPriceIds, { month: 'pri_pro_month_trial', year: 'pri_pro_year_trial' });
  eq('the trial length is stated', pw.trialDays, 3);
  check('the first charge date is three days out', Math.abs(pw.firstChargeAt - (now() + 3 * 86400)) < 5, pw.firstChargeAt);
  check('the credit packs are offered as well', Array.isArray(pw.credits.packs) && pw.credits.packs.length === 3, pw.credits?.packs?.length);
  check('checkout has what Paddle.js needs', pw.paddle.customData.tenant_id === lockedTid, pw.paddle);
}

/* ---------- D2. no hole in the wall ---------- */
section('D2. every route behind the guard answers 402');
{
  /** The paywall leaves these open on purpose: pay, see the plan, log out, leave. Kept in step with isOpenPath(). */
  const OPEN = (p: string) => p === '/api/health' || p === '/api/plan' || p === '/api/plans' || p === '/api/paywall'
    || p.startsWith('/api/auth/') || p.startsWith('/api/billing/') || p.startsWith('/api/webhooks/');

  /**
   * Hono matches handlers in registration order, so anything mounted BEFORE the guard bypasses the paywall entirely.
   * These are the routes that have to work without a session at all (webhooks, OAuth callbacks, the harvester upload,
   * the Companion's device-token endpoints). A new entry showing up here means somebody put a data route in front of
   * the wall — decide deliberately, then add it below.
   */
  const PUBLIC_API = new Set([
    'GET /api/health',
    'GET /api/auth/me', 'POST /api/auth/login', 'POST /api/auth/signup', 'POST /api/auth/logout',
    'GET /api/webhooks/instagram', 'POST /api/webhooks/instagram', 'POST /api/webhooks/paddle',
    'GET /api/plans',
    'POST /api/import/harvest-form', // token-authenticated upload from the harvester; the token itself needs a session
    'GET /api/instagram/callback', 'POST /api/instagram/deauthorize', 'POST /api/instagram/delete',
    'POST /api/companion/pair', 'GET /api/companion/state', 'POST /api/companion/harvest',
    'POST /api/companion/session', 'DELETE /api/companion/session', 'DELETE /api/companion/device',
  ]);

  const routes = (app as any).routes as Array<{ path: string; method: string; handler: unknown }>;
  const guardAt = routes.findIndex((r) => r.handler === paywallGuard);
  check('the guard is mounted', guardAt >= 0, guardAt);
  const inFront = [...new Set(routes.slice(0, guardAt).filter((r) => r.path.startsWith('/api')).map((r) => `${r.method} ${r.path}`))];
  const unexpected = inFront.filter((r) => !PUBLIC_API.has(r));
  check('no new route was mounted in front of the paywall', unexpected.length === 0, unexpected);

  // Every GET registered behind the guard, params filled in. If the guard works, none of them reaches its handler.
  const behind = [...new Set(routes.slice(guardAt + 1).filter((r) => r.method === 'GET' && r.path.startsWith('/api/') && !OPEN(r.path)).map((r) => r.path))];
  const leaks: string[] = [];
  for (const p of behind) {
    const url = p.replace(/:[A-Za-z0-9_]+/g, '1');
    const r = await get(url, lockedCookie);
    if (r.status !== 402) leaks.push(`${url} → ${r.status}`);
  }
  check(`all ${behind.length} GET routes behind the wall answer 402`, leaks.length === 0, leaks);

  // The ones that cost money or write data, by hand (a sweep of every POST would be a sweep of every side effect).
  const posts: Array<[string, unknown]> = [
    ['/api/ask', { question: 'hello' }],
    ['/api/jobs/queue', {}],
    ['/api/import/urls', { urls: ['https://www.instagram.com/p/abc/'] }],
    ['/api/automations/rules', { name: 'x', trigger: 'dm_keyword' }],
    ['/api/profile/score', {}],
    ['/api/instagram/waitlist', { email: 'x@example.com' }],
    ['/api/items/bulk', { ids: [], action: 'delete' }],
  ];
  const postLeaks: string[] = [];
  for (const [p, body] of posts) {
    const r = await post(p, body, lockedCookie);
    if (r.status !== 402) postLeaks.push(`${p} → ${r.status}`);
  }
  check('the metered POSTs answer 402 too', postLeaks.length === 0, postLeaks);
}

/* ---------- E. a grandfathered tenant is untouched ---------- */
section('E. grandfathered tenant');
{
  const t = now();
  const oldTid = Number(d.prepare("INSERT INTO tenants (name, plan, plan_status, trial_ends_at, created_at, updated_at) VALUES ('old timer', 'trial', 'active', ?, ?, ?)").run(t + 86400, t, t).lastInsertRowid);
  const uid = Number(d.prepare('INSERT INTO users (tenant_id, email, password_hash, is_owner, created_at) VALUES (?, ?, NULL, 0, ?)').run(oldTid, `old-${t}@example.com`, t).lastInsertRowid);
  const cookie = `rs_session=${createSessionToken(`old-${t}@example.com`, oldTid, uid)}`;
  const r = await get('/api/items', cookie);
  check('the app works normally', r.status === 200, r.status);
  const pw = await (await get('/api/paywall', cookie)).json() as any;
  eq('and the paywall knows it was never required', [pw.locked, pw.reason], [false, 'not_required']);
  eq('/api/plan carries the paywall state', planPayload(oldTid).paywall.locked, false);

  // The founder's father is in this state: signed up before the paywall, trial long gone, no card. He falls back to
  // the free tier (browse and export) — a quota 402 on the metered routes, never a payment_required wall.
  const lapsedMail = `lapsed-${t}@example.com`;
  const lapsedTid = Number(d.prepare("INSERT INTO tenants (name, plan, plan_status, trial_ends_at, created_at, updated_at) VALUES ('lapsed', 'trial', 'active', ?, ?, ?)").run(t - 86400, t - 30 * 86400, t).lastInsertRowid);
  const lapsedUid = Number(d.prepare('INSERT INTO users (tenant_id, email, password_hash, is_owner, created_at) VALUES (?, ?, NULL, 0, ?)').run(lapsedTid, lapsedMail, t).lastInsertRowid);
  const lapsedCookie = `rs_session=${createSessionToken(lapsedMail, lapsedTid, lapsedUid)}`;
  eq('an expired trial from before the paywall is still not locked', paywallState(lapsedTid).locked, false);
  eq('its effective plan is free', planPayload(lapsedTid).effectivePlan, 'free');
  for (const p of ['/api/items', '/api/stats', '/api/export?format=json', '/api/onboarding']) {
    const rl = await get(p, lapsedCookie);
    check(`${p} still works for them`, rl.status === 200, rl.status);
  }
  const ask = await post('/api/ask', { question: 'hello' }, lapsedCookie);
  const askBody = await ask.json().catch(() => ({})) as any;
  check('and a metered route says quota, not payment_required', ask.status !== 402 || askBody.code === 'quota', { status: ask.status, code: askBody.code });
}

/* ---------- F. the owner is never billable ---------- */
section('F. owner tenant');
{
  const ownerUid = (d.prepare('SELECT id FROM users WHERE tenant_id = 1 AND is_owner = 1').get() as any)?.id || 0;
  const cookie = `rs_session=${createSessionToken('owner@example.com', 1, ownerUid)}`;
  const r = await get('/api/items', cookie);
  check('the owner is never locked', r.status === 200, r.status);
  eq('and the state says why', paywallState(1).reason, 'owner');
}

/* ---------- G. the webhook lifts the lock ---------- */
section('G. Paddle webhook — trialing subscription');
{
  const firstCharge = now() + 3 * 86400;
  const evt = {
    event_id: `evt_${Date.now()}_sub`,
    event_type: 'subscription.created',
    data: {
      id: 'sub_test_1', status: 'trialing', customer_id: 'ctm_test_1',
      custom_data: { tenant_id: lockedTid },
      items: [{ price: { id: 'pri_pro_month_trial' }, quantity: 1 }],
      next_billed_at: new Date(firstCharge * 1000).toISOString(),
      current_billing_period: { starts_at: new Date().toISOString(), ends_at: new Date(firstCharge * 1000).toISOString() },
      started_at: new Date().toISOString(),
    },
  };
  const r = await handlePaddleEvent(evt);
  check('handled', r.handled, r);
  const t = tenantOf(lockedTid);
  eq('the lock is gone', Number(t.requires_payment), 0);
  check('and when it went is recorded', Number(t.paywall_cleared_at) > 0, t.paywall_cleared_at);
  eq('the plan came from the trial price id', t.plan, 'pro');
  eq("trial_ends_at is Paddle's first charge date, not our guess", Number(t.trial_ends_at), firstCharge);
  eq('paywallState agrees', [paywallState(lockedTid).locked, paywallState(lockedTid).reason], [false, 'cleared']);

  const items = await get('/api/items', lockedCookie);
  check('the app is usable again', items.status === 200, items.status);

  // A redelivered event must not undo anything, and a later cancellation must not re-lock the account.
  const again = await handlePaddleEvent({ ...evt, event_id: `${evt.event_id}_again` });
  check('a redelivered event is harmless', again.handled && Number(tenantOf(lockedTid).requires_payment) === 0, again);
  await handlePaddleEvent({
    event_id: `evt_${Date.now()}_cancel`, event_type: 'subscription.canceled',
    data: { id: 'sub_test_1', status: 'canceled', customer_id: 'ctm_test_1', custom_data: { tenant_id: lockedTid }, items: [{ price: { id: 'pri_pro_month_trial' } }], current_billing_period: { ends_at: new Date((now() + 86400) * 1000).toISOString() } },
  });
  const cancelled = tenantOf(lockedTid);
  eq('cancelling does not re-lock the account', Number(cancelled.requires_payment), 0);
  eq('and does not end the paid period early', cancelled.plan_status, 'canceled');
  check('access runs to the end of the period', Number(cancelled.plan_renews_at) > now(), cancelled.plan_renews_at);
}

/* ---------- H. a credit pack also lifts the lock ---------- */
section('H. Paddle webhook — credit pack');
{
  const email2 = `paywall-credits-${Date.now()}@example.com`;
  const res = await app.request('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email2, password: 'test-password-2' }) });
  const body = await res.json() as any;
  const tid2 = body.tenantId as number;
  const uid2 = (d.prepare('SELECT id FROM users WHERE tenant_id = ?').get(tid2) as any).id;
  const cookie2 = `rs_session=${createSessionToken(email2, tid2, uid2)}`;
  eq('locked at signup', paywallState(tid2).locked, true);

  await handlePaddleEvent({
    event_id: `evt_${Date.now()}_txn`, event_type: 'transaction.completed',
    data: { id: 'txn_test_2', customer_id: 'ctm_test_2', custom_data: { tenant_id: tid2 }, items: [{ price: { id: 'pri_credits_500' }, quantity: 1 }] },
  });
  eq('the lock is gone', Number(tenantOf(tid2).requires_payment), 0);
  eq('the credits arrived', creditBalance(tid2), 500);
  eq('but no plan was granted', tenantOf(tid2).plan, 'trial');
  const r = await get('/api/items', cookie2);
  check('the app is usable', r.status === 200, r.status);

  // Deleting the account is allowed even while locked — nobody is trapped behind the wall.
  const email3 = `paywall-delete-${Date.now()}@example.com`;
  const res3 = await app.request('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email3, password: 'test-password-3' }) });
  const b3 = await res3.json() as any;
  const uid3 = (d.prepare('SELECT id FROM users WHERE tenant_id = ?').get(b3.tenantId) as any).id;
  const cookie3 = `rs_session=${createSessionToken(email3, b3.tenantId, uid3)}`;
  eq('locked at signup', paywallState(b3.tenantId).locked, true);
  const del = await app.request('/api/account', { method: 'DELETE', headers: { cookie: cookie3 } });
  check('DELETE /api/account works while locked', del.status === 200, del.status);
}

/* ---------- I. fail-open ---------- */
section('I. a broken deploy never locks anybody out');
{
  const email4 = `paywall-open-${Date.now()}@example.com`;
  const t = now();
  const tid4 = Number(d.prepare("INSERT INTO tenants (name, plan, plan_status, trial_ends_at, requires_payment, created_at, updated_at) VALUES ('locked one', 'trial', 'active', ?, 1, ?, ?)").run(t + 86400, t, t).lastInsertRowid);
  const uid4 = Number(d.prepare('INSERT INTO users (tenant_id, email, password_hash, is_owner, created_at) VALUES (?, ?, NULL, 0, ?)').run(tid4, email4, t).lastInsertRowid);
  const cookie4 = `rs_session=${createSessionToken(email4, tid4, uid4)}`;
  check('locked while the prices are configured', (await get('/api/items', cookie4)).status === 402);

  const saved = process.env.PADDLE_PRICE_PRO_MONTH_TRIAL;
  delete process.env.PADDLE_PRICE_PRO_MONTH_TRIAL;
  check('unlocked the moment the prices go missing', (await get('/api/items', cookie4)).status === 200);
  const pw = await (await get('/api/paywall', cookie4)).json() as any;
  eq('and /api/paywall says the paywall is off', [pw.locked, pw.reason], [false, 'disabled']);
  process.env.PADDLE_PRICE_PRO_MONTH_TRIAL = saved;
  check('locked again once the deploy is fixed', (await get('/api/items', cookie4)).status === 402);

  // clearPaywall is idempotent: the second call changes nothing and stays quiet.
  eq('clearing works once', clearPaywall(tid4, 'test'), true);
  eq('and is a no-op after that', clearPaywall(tid4, 'test'), false);
}

/* ---------- J. grandfathering survives an upgrade (fix pass) ---------- */
section('J. a grandfathered tenant stays grandfathered after paying');
{
  // Migration 009 documents `paywall_cleared_at IS NULL` as "signed up before the paywall existed", and support
  // reads it that way. clearPaywall used to fire for every card-on-file event regardless of whether the tenant was
  // ever locked, so a pre-round-7 account that upgraded got the column stamped and /start started telling them
  // their card had lifted a lock they never met.
  const d = db();
  const t = now();
  const old = Number(d.prepare("INSERT INTO tenants (name, plan, plan_status, requires_payment, paywall_cleared_at, created_at, updated_at) VALUES ('grandfathered', 'trial', 'active', 0, NULL, ?, ?)").run(t, t).lastInsertRowid);
  eq('starts as not_required', paywallState(old).reason, 'not_required');
  eq('a card-on-file event changes nothing', clearPaywall(old, 'upgraded'), false);
  eq('paywall_cleared_at is still null', (d.prepare('SELECT paywall_cleared_at AS c FROM tenants WHERE id = ?').get(old) as any).c, null);
  eq('and the reason still reads not_required, not cleared', paywallState(old).reason, 'not_required');

  const locked = Number(d.prepare("INSERT INTO tenants (name, plan, plan_status, requires_payment, created_at, updated_at) VALUES ('locked', 'trial', 'active', 1, ?, ?)").run(t, t).lastInsertRowid);
  eq('a genuinely locked tenant is cleared', clearPaywall(locked, 'card arrived'), true);
  check('and is stamped with the moment it happened', Number((d.prepare('SELECT paywall_cleared_at AS c FROM tenants WHERE id = ?').get(locked) as any).c) > 0);
  eq('which reads as cleared', paywallState(locked).reason, 'cleared');
}

/* ---------- K. an event we cannot attach to an account (fix pass) ---------- */
section('K. a Paddle event with no tenant is retried, not swallowed');
{
  // The one failure we must not absorb: the person has paid and is still behind the paywall. Answering 200 and
  // remembering the event id burned the redelivery too, so recovery meant hand-written SQL and a Paddle event that
  // could never be replayed. Not remembered → not a duplicate → still fixable when support attaches the customer id.
  // resolveTenant's last resort is a Paddle customer lookup; stub it so the test makes no network call at all.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const evt = {
    event_id: 'evt_no_tenant_1',
    event_type: 'subscription.created',
    data: { id: 'sub_orphan', customer_id: 'ctm_nobody_here', status: 'trialing', items: [{ price: { id: 'pri_pro_month_trial' } }] },
  };
  const first = await handlePaddleEvent(evt as any);
  eq('not handled', first.handled, false);
  eq('and asks Paddle to try again', first.retry, true);

  const d = db();
  const t = now();
  const rescued = Number(d.prepare("INSERT INTO tenants (name, plan, plan_status, requires_payment, paddle_customer_id, created_at, updated_at) VALUES ('rescued', 'trial', 'active', 1, 'ctm_nobody_here', ?, ?)").run(t, t).lastInsertRowid);
  const second = await handlePaddleEvent(evt as any);
  eq('the redelivery of the SAME event id now lands', second.handled, true);
  check('not discarded as a duplicate', !/duplicate/.test(second.note), second.note);
  eq('and the lock is lifted', paywallState(rescued).locked, false);
  globalThis.fetch = realFetch;
}

/* ---------- done ---------- */
console.log(`\n${failures.length ? 'FAILED' : 'PASSED'} — ${pass} checks passed, ${failures.length} failed`);
if (failures.length) for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);
