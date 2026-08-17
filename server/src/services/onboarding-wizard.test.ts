/**
 * In-process test for the /welcome wizard's server-side state (ROUND7-SPEC §2). No test runner, no ports:
 *
 *   npx tsx server/src/services/onboarding-wizard.test.ts
 *
 * The wizard has to survive a reload and a second device, so the screen a person reached lives in the tenant's
 * onboarding meta (`welcome_seen`, `welcome_step`, `welcome_done`) and comes back on `GET /api/onboarding`. Covers:
 * the new key round-trips, it only ever moves forward, junk and out-of-range values cannot corrupt it, one tenant
 * cannot see another's progress, and an unknown key still answers 400 — the case the web client treats as "this
 * server predates the key" rather than an error to show the person.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resurfly-onboarding-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';
process.env.HOSTED = 'true';
process.env.SESSION_SECRET = 'test-session-secret-value-0123456789';
process.env.APP_USERNAME = 'owner@example.com';
process.env.AUTO_START_WORKER = 'false';
process.env.SERVER_HARVEST_ENABLED = 'false';
process.env.OPENAI_API_KEY = '';
process.env.META_APP_ID = '';
process.env.META_APP_SECRET = '';
// No Paddle trial prices on purpose: the signup paywall forces itself off, so these calls are never answered with 402.
for (const k of ['PADDLE_PRICE_PRO_MONTH_TRIAL', 'PADDLE_PRICE_PRO_YEAR_TRIAL', 'PADDLE_PRICE_STUDIO_MONTH_TRIAL', 'PADDLE_PRICE_STUDIO_YEAR_TRIAL']) delete process.env[k];

let failures = 0;
let pass = 0;
function check(name: string, cond: unknown, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}
const eq = (name: string, actual: unknown, expected: unknown) => check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

async function main() {
  const { createApp } = await import('../app.js');
  const { db, now } = await import('../db.js');
  const { createSessionToken } = await import('../auth.js');

  const app = createApp();
  const d = db();
  const t = now();

  /** A tenant with its own login, the way a hosted signup leaves things. */
  function person(name: string) {
    const tid = Number(d.prepare('INSERT INTO tenants (name, plan, plan_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(name, 'trial', 'active', t, t).lastInsertRowid);
    const email = `${name}-${t}@example.com`;
    const uid = Number(d.prepare('INSERT INTO users (tenant_id, email, password_hash, is_owner, created_at) VALUES (?, ?, NULL, 1, ?)').run(tid, email, t).lastInsertRowid);
    return { tid, cookie: `rs_session=${createSessionToken(email, tid, uid)}` };
  }
  const state = async (cookie: string) => await (await app.request('/api/onboarding', { headers: { cookie } })).json() as any;
  const event = (cookie: string, body: unknown) => app.request('/api/onboarding/event', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const a = person('wizard-a');
  const b = person('wizard-b');
  console.log(`tenants ${a.tid} and ${b.tid}, db at ${dir}`);

  console.log('\na brand-new account');
  const fresh = await state(a.cookie);
  eq('has never started the wizard', [fresh.welcomeSeen, fresh.welcomeDone, fresh.welcomeStep], [false, false, 0]);
  eq('and counts as a first run', fresh.firstRun, true);

  console.log('\nopening the wizard');
  eq('welcome_seen is accepted', (await event(a.cookie, { key: 'welcome_seen' })).status, 200);
  eq('and comes back as seen, still unfinished', [(await state(a.cookie)).welcomeSeen, (await state(a.cookie)).welcomeDone], [true, false]);

  console.log('\nthe furthest screen reached');
  eq('screen 3 round-trips', (await (await event(a.cookie, { key: 'welcome_step', value: 3 })).json() as any).welcomeStep, 3);
  eq('walking back to 2 does not lose it', (await (await event(a.cookie, { key: 'welcome_step', value: 2 })).json() as any).welcomeStep, 3);
  eq('a value past the last screen clamps to 5', (await (await event(a.cookie, { key: 'welcome_step', value: 99 })).json() as any).welcomeStep, 5);
  eq('junk cannot corrupt it', (await (await event(a.cookie, { key: 'welcome_step', value: 'four' })).json() as any).welcomeStep, 5);
  eq('nor can a missing value', (await (await event(a.cookie, { key: 'welcome_step' })).json() as any).welcomeStep, 5);

  console.log('\nfinishing');
  eq('welcome_done sticks', (await (await event(a.cookie, { key: 'welcome_done' })).json() as any).welcomeDone, true);

  console.log('\nother accounts and other keys');
  eq('the other tenant is untouched', [(await state(b.cookie)).welcomeStep, (await state(b.cookie)).welcomeDone], [0, false]);
  const bad = await event(a.cookie, { key: 'welcome_stepp', value: 2 });
  eq('an unknown key is refused', bad.status, 400);
  check('and names the keys it accepts', /welcome_step/.test((await bad.json() as any).error || ''), await bad.text().catch(() => ''));
  eq('a refused key changed nothing', (await state(a.cookie)).welcomeStep, 5);

  /* ---- fix pass (§3): the checklist may not recommend what the platform forbids ---- */
  console.log('\nthe dashboard checklist never points at a Connect that cannot work');
  // `connectAvailable` used to be `!!META_APP_ID` — so on the hosted app in Development mode the checklist badged
  // "Connect Instagram" as the next thing to do, one click from the dashboard, for somebody who cannot connect at
  // all. It now asks the same availability service every other surface asks.
  const c = person('wizard-c');
  for (const key of ['asked', 'explored']) await event(c.cookie, { key });
  d.prepare(`INSERT INTO items (id, url, tenant_id, media_type, analysis_status, analysis, created_at, updated_at, saved_at)
    VALUES (?, ?, ?, 'video', 'done', ?, ?, ?, ?)`).run(`itm-wiz-${t}`, 'https://instagram.com/p/wiz', c.tid, JSON.stringify({ category: 'cooking' }), t, t, t);
  const done = await state(c.cookie);
  eq('with no Meta app at all, connecting is not offered', done.steps.connectInstagram.available, false);
  check('and it is not the suggested next step', done.suggestedNext !== 'connect', done.suggestedNext);
}

await main();
console.log(`\n${failures ? 'FAILED' : 'PASSED'} — ${pass} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
