/**
 * In-process test for credits (ROUND6-SPEC §3). No test runner needed:
 *
 *   npx tsx server/src/services/credits.test.ts
 *
 * It runs against a throwaway SQLite database in the OS temp directory (DATA_DIR is set before anything is imported),
 * so it never touches ./data. Covers: allowance exhausted → 402 with credit info; a ledger grant makes the same call
 * succeed and the ledger balances; the sends rate (1 credit = 20 replies); a Paddle credit purchase is idempotent;
 * the worker leaves items pending instead of failing them when allowance and credits are both gone.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resurfly-credits-'));
process.env.DATA_DIR = dir;
process.env.HOSTED = 'true';
process.env.OPENAI_API_KEY = 'sk-test-not-used';
process.env.PADDLE_PRICE_CREDITS_500 = 'pri_test_500';
process.env.PADDLE_PRICE_CREDITS_2000 = 'pri_test_2000';
process.env.PADDLE_PRICE_CREDITS_6000 = 'pri_test_6000';
process.env.PADDLE_PRICE_PRO_MONTH = 'pri_test_pro_month';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

async function main() {
  const { db, now } = await import('../db.js');
  const { addCredits, creditBalance, creditLedger, creditRemainder, spendCredits } = await import('./credits.js');
  const { PLANS, PRICES, chargeMetered, checkQuota, planCatalog, planPayload, quotaResponse } = await import('./plans.js');
  const { handlePaddleEvent } = await import('./paddle.js');
  const { worker } = await import('./worker.js');

  const d = db();
  const t = now();
  const tid = Number(d.prepare("INSERT INTO tenants (name, plan, plan_status, created_at, updated_at) VALUES ('test', 'pro', 'active', ?, ?)").run(t, t).lastInsertRowid);
  console.log(`tenant ${tid} on pro, db at ${dir}`);

  /* ---------------- prices ---------------- */
  console.log('\nprices');
  eq('pro is $19 / $144', [PRICES.pro.month, PRICES.pro.year], [19, 144]);
  eq('studio is $49 / $348', [PRICES.studio.month, PRICES.studio.year], [49, 348]);
  const cat = planCatalog();
  const proCard = cat.plans.find((p) => p.id === 'pro')!;
  eq('yearly pro is $12/month, 37% less', [proCard.priceYearPerMonth, proCard.yearSavePercent], [12, 37]);
  eq('pack catalogue', cat.credits.packs.map((p) => [p.credits, p.price, p.priceId]), [[500, 12, 'pri_test_500'], [2000, 39, 'pri_test_2000'], [6000, 99, 'pri_test_6000']]);
  eq('credit rates', cat.credits.rates, { analyze: 1, ask: 1, sends: 20 });

  /* ---------------- ask: allowance exhausted → 402 with credits ---------------- */
  console.log('\nask: allowance exhausted');
  // Straight into the usage table: bumpUsage would also fill the per-minute Ask window, which is a rate limit and has
  // nothing to do with the monthly allowance under test.
  const useUp = (metric: string, count: number, period = new Date().toISOString().slice(0, 7)) =>
    d.prepare('INSERT INTO usage (tenant_id, period, metric, count) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, period, metric) DO UPDATE SET count = excluded.count').run(tid, period, metric, count);
  useUp('ask', PLANS.pro.askPerMonth);
  let q = checkQuota(tid, 'ask', 1);
  check('quota is not ok', !q.ok, q);
  check('allowance is gone', !q.okAllowance && q.remaining === 0, q);
  eq('no credits yet', [q.creditsAvailable, q.wouldUseCredits], [0, false]);
  eq('one credit would cover it', q.creditsNeeded, 1);

  // the 402 body a route would return
  let body: any = null;
  let status = 0;
  const fakeCtx = { json: (b: any, s: number) => { body = b; status = s; return b; }, get: () => ({ tid }) } as any;
  quotaResponse(fakeCtx, q, tid);
  eq('HTTP 402', status, 402);
  eq('402 shape', Object.keys(body).sort(), ['code', 'credits', 'error', 'limit', 'metric', 'plan', 'remaining', 'resetsAt', 'upgrade', 'used', 'window']);
  eq('402 credits block', { balance: body.credits.balance, needed: body.credits.needed, eligible: body.credits.eligible, packs: body.credits.packs.length }, { balance: 0, needed: 1, eligible: true, packs: 3 });
  check('402 names the metric', body.metric === 'ask' && body.code === 'quota', body);

  /* ---------------- grant credits → the same call succeeds ---------------- */
  console.log('\ngrant credits');
  const grant = addCredits(tid, 5, 'grant', 'test-grant-1');
  eq('granted 5', [grant.added, grant.balance, grant.duplicate], [5, 5, false]);
  eq('same ref is a no-op', addCredits(tid, 5, 'grant', 'test-grant-1').duplicate, true);
  eq('balance after the duplicate', creditBalance(tid), 5);

  q = checkQuota(tid, 'ask', 1);
  check('quota is ok again', q.ok, q);
  eq('and it will be paid with credits', [q.okAllowance, q.wouldUseCredits, q.creditsAvailable, q.creditsNeeded], [false, true, 5, 1]);

  const charged = chargeMetered(tid, 'ask', 1, 'ask');
  eq('one credit spent', [charged.ok, charged.fromAllowance, charged.fromCredits, charged.creditsSpent, charged.balance], [true, 0, 1, 1, 4]);
  const led = creditLedger(tid, 20);
  eq('ledger balances', led.reduce((n, r) => n + r.delta, 0), creditBalance(tid));
  eq('newest ledger row', [led[0].delta, led[0].reason, led[0].balanceAfter], [-1, 'ask', 4]);
  eq('usage did not overshoot the allowance', planPayload(tid).usage.ask, { used: PLANS.pro.askPerMonth, limit: PLANS.pro.askPerMonth });
  eq('plan payload carries the balance and the ledger', [planPayload(tid).credits.balance, planPayload(tid).credits.ledger.length], [4, 2]);

  /* ---------------- never negative ---------------- */
  console.log('\nnever negative');
  const tooMuch = spendCredits(tid, 'ask', 99);
  eq('spending more than the balance fails and changes nothing', [tooMuch.ok, creditBalance(tid)], [false, 4]);
  eq('no ledger row was written', creditLedger(tid, 20).length, 2);

  /* ---------------- sends: 1 credit = 20 replies ---------------- */
  console.log('\nsends: 1 credit = 20 replies');
  useUp('sends', PLANS.pro.sendsPerMonth);
  const s1 = chargeMetered(tid, 'sends', 1, 'rule:1');
  eq('the first reply costs a whole credit', [s1.creditsSpent, s1.balance], [1, 3]);
  eq('19 replies are banked', creditRemainder(tid, 'sends'), 19);
  for (let i = 0; i < 19; i++) chargeMetered(tid, 'sends', 1, 'rule:1');
  eq('those 19 cost nothing more', [creditBalance(tid), creditRemainder(tid, 'sends')], [3, 0]);
  eq('the 21st takes the next credit', chargeMetered(tid, 'sends', 1, 'rule:1').balance, 2);
  eq('sends quota reports the credit cover', checkQuota(tid, 'sends', 1).creditUnitsAvailable, 2 * 20 + 19);

  /* ---------------- Paddle credit purchase is idempotent ---------------- */
  console.log('\npaddle: credit purchase');
  const txn = (eventId: string) => ({
    event_id: eventId,
    event_type: 'transaction.completed',
    data: { id: 'txn_test_1', customer_id: 'ctm_test_1', custom_data: { tenant_id: tid }, items: [{ price: { id: 'pri_test_500' }, quantity: 1 }] },
  });
  const before = creditBalance(tid);
  const r1 = await handlePaddleEvent(txn('evt_1'));
  eq('500 credits added', [r1.handled, creditBalance(tid)], [true, before + 500]);
  const r2 = await handlePaddleEvent(txn('evt_2')); // same transaction, new event id (Meta/Paddle redelivery)
  eq('a redelivery adds nothing', [r2.handled, creditBalance(tid)], [true, before + 500]);
  eq('one purchase row in the ledger', creditLedger(tid, 50).filter((r) => r.reason === 'purchase').length, 1);
  eq('ledger still balances', creditLedger(tid, 200).reduce((n, r) => n + r.delta, 0), creditBalance(tid));
  const tenantRow = db().prepare('SELECT plan, paddle_price_id FROM tenants WHERE id = ?').get(tid) as any;
  eq('a credit pack does not touch the plan', [tenantRow.plan, tenantRow.paddle_price_id], ['pro', null]);

  /* ---------------- worker: items stay pending, never failed ---------------- */
  console.log('\nworker: no allowance, no credits');
  d.prepare('UPDATE tenants SET credits = 0 WHERE id = ?').run(tid);
  d.prepare("DELETE FROM meta WHERE tenant_id = ? AND key = 'credit_units_sends'").run(tid);
  useUp('analyze', PLANS.pro.analyzePerMonth);
  const ins = d.prepare("INSERT INTO items (id, url, media_type, saved_at, saved_rank, analysis_status, queue_state, tenant_id, created_at, updated_at) VALUES (?, ?, 'image', ?, ?, 'pending', 'idle', ?, ?, ?)");
  for (let i = 0; i < 3; i++) ins.run(`t${tid}_item${i}`, `https://example.com/${i}`, t, i, tid, t, t);

  const e1 = worker.enqueue(tid, 'pending');
  eq('nothing is queued, all three are reported as left out', [e1.queued, e1.leftOut], [0, 3]);
  let pending = (d.prepare("SELECT COUNT(*) AS n FROM items WHERE tenant_id = ? AND analysis_status = 'pending'").get(tid) as any).n;
  let failed = (d.prepare("SELECT COUNT(*) AS n FROM items WHERE tenant_id = ? AND analysis_status = 'failed'").get(tid) as any).n;
  eq('the saves are still pending, none failed', [pending, failed], [3, 0]);
  const st = worker.status(tid);
  eq('jobs/status says why', [st.blocked, st.blockedPending, st.blockedReason, st.credits, st.pending], [true, 3, 'allowance', 0, 3]);
  check('jobs/status quota is not ok', st.quota !== null && st.quota.ok === false, st.quota);

  console.log('\nworker: with credits');
  addCredits(tid, 2, 'grant', 'test-grant-2');
  const e2 = worker.enqueue(tid, 'pending');
  eq('two credits queue two saves, one is left out', [e2.queued, e2.leftOut], [2, 1]);
  const st2 = worker.status(tid);
  eq('no longer blocked', [st2.blocked, st2.credits], [false, 2]);
  worker.dequeueAll(tid);

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
