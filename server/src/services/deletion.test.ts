/**
 * In-process test for the fix-pass changes that had no home in the existing suites (ROUND7 §2, §3, §7):
 *
 *   npx tsx server/src/services/deletion.test.ts
 *
 * Runs against a throwaway SQLite database in the OS temp directory, with `fetch` routed by URL so Meta's app probe,
 * Meta's Graph calls and Paddle's API can all be observed without leaving the process. Covers:
 *
 *   A. the OAuth round trip returns to the screen that started it, and `?next=` can never be an open redirect
 *   B. removing the app under Instagram → Apps and websites wipes the message data, as /privacy promises
 *   C. the data-deletion callback leaves a record a human can look the confirmation code up in
 *   D. deleting the account cancels the Paddle subscription instead of billing an account nobody can log into
 *   E. the orphan media sweep finishes an interrupted deletion, and never reads an empty database as an empty library
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resurfly-deletion-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';
process.env.HOSTED = 'true';
process.env.AUTO_START_WORKER = 'false';
process.env.SERVER_HARVEST_ENABLED = 'false';
process.env.OPENAI_API_KEY = '';
process.env.APP_USERNAME = 'owner@example.com';
process.env.SESSION_SECRET = 'test-session-secret-value-0123456789';
process.env.META_APP_ID = '1234567890';
process.env.META_APP_SECRET = 'app-secret-must-never-leak';
process.env.PADDLE_ENV = 'sandbox';
process.env.PADDLE_API_KEY = 'test_api_key';
// Deliberately no PADDLE_PRICE_*_TRIAL: the paywall stays off so its guard cannot colour these assertions.
delete process.env.META_APP_LIVE;

let failures = 0;
function check(name: string, cond: unknown, detail?: unknown) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
const section = (s: string) => console.log(`\n=== ${s} ===`);

/* ---------- fetch, routed by host ---------- */
const calls: Array<{ method: string; url: string }> = [];
let paddleStatus = 200;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  const method = String(init?.method || 'GET').toUpperCase();
  calls.push({ method, url });
  if (url.includes('paddle.com')) {
    return paddleStatus === 200
      ? new Response(JSON.stringify({ data: { id: 'sub_1', status: 'canceled' } }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify({ error: { code: 'forbidden', detail: 'the key cannot cancel this subscription' } }), { status: paddleStatus, headers: { 'content-type': 'application/json' } });
  }
  // Meta: the daily app probe, and anything the disconnect path touches.
  return new Response(JSON.stringify({ id: '1234567890', name: 'Resurfly', category: 'Utility', success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
const paddleCalls = () => calls.filter((c) => c.url.includes('paddle.com'));

const { config } = await import('../config.js');
const { createApp } = await import('../app.js');
const { db, getMeta, now } = await import('../db.js');
const { createSessionToken } = await import('../auth.js');
const { connectUrl, signState, verifyState } = await import('./instagram.js');
const { _resetIgAvailability } = await import('./ig-availability.js');
const { sweepOrphanMedia } = await import('./media.js');

const d = db();
const app = createApp();

/** A tenant with a user row, so `createSessionToken` produces a session the app will accept. */
function makeTenant(name: string): { tid: number; uid: number; cookie: string } {
  const t = now();
  const tid = Number(d.prepare('INSERT INTO tenants (name, plan, plan_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(name, 'trial', 'active', t, t).lastInsertRowid);
  const email = `${name}@example.com`;
  const uid = Number(d.prepare('INSERT INTO users (tenant_id, email, password_hash, is_owner, created_at) VALUES (?, ?, ?, 0, ?)').run(tid, email, 'x', t).lastInsertRowid);
  return { tid, uid, cookie: `rs_session=${createSessionToken(email, tid, uid)}` };
}

/** Meta's `signed_request`: base64url(HMAC-SHA256(payload)) + '.' + base64url(payload). */
function signedRequest(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', ...payload })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.metaAppSecret).update(body).digest('base64url');
  return `${sig}.${body}`;
}

/** Fill every table the deauthorize/deletion promise names, so a wipe has something to prove. */
function seedInstagram(tid: number, igUserId: string): void {
  const t = now();
  d.prepare('INSERT INTO ig_accounts (tenant_id, ig_user_id, username, access_token_enc, connected_at) VALUES (?, ?, ?, ?, ?)').run(tid, igUserId, 'a_customer', 'enc', t);
  d.prepare("INSERT INTO automation_events (tenant_id, ts, type, direction, sender_id, sender_username, text, status) VALUES (?, ?, 'dm', 'in', '999', 'a_stranger', 'is this still available?', 'ok')").run(tid, t);
  d.prepare("INSERT INTO automation_contacts (tenant_id, ig_id, username, first_seen, last_seen, message_count) VALUES (?, '999', 'a_stranger', ?, ?, 1)").run(tid, t, t);
  d.prepare("INSERT INTO ig_media (tenant_id, id, caption, media_type, fetched_at) VALUES (?, '17900000000000001', 'a post', 'IMAGE', ?)").run(tid, t);
  d.prepare("INSERT INTO ig_insights_daily (tenant_id, day, metric, value) VALUES (?, '2026-08-16', 'reach', 120)").run(tid);
  d.prepare('INSERT INTO ig_snapshots (tenant_id, taken_at, followers_count) VALUES (?, ?, 400)').run(tid, t);
}
const igRowCounts = (tid: number) => ({
  accounts: (d.prepare('SELECT COUNT(*) n FROM ig_accounts WHERE tenant_id = ?').get(tid) as any).n,
  events: (d.prepare('SELECT COUNT(*) n FROM automation_events WHERE tenant_id = ?').get(tid) as any).n,
  contacts: (d.prepare('SELECT COUNT(*) n FROM automation_contacts WHERE tenant_id = ?').get(tid) as any).n,
  media: (d.prepare('SELECT COUNT(*) n FROM ig_media WHERE tenant_id = ?').get(tid) as any).n,
  insights: (d.prepare('SELECT COUNT(*) n FROM ig_insights_daily WHERE tenant_id = ?').get(tid) as any).n,
  snapshots: (d.prepare('SELECT COUNT(*) n FROM ig_snapshots WHERE tenant_id = ?').get(tid) as any).n,
});

/* ------------------------------------------------------------------ */
section('A. the OAuth round trip comes back to the screen that started it');
{
  const me = makeTenant('oauth-returner');
  const RETURN_TO = '/welcome?step=4';

  // The wizard's screen 4 says "then straight back here". That is only true if the path survives the round trip, and it
  // can only survive inside the signed state — a plain query parameter on the callback would be forgeable.
  const st = verifyState(signState(me.tid, me.uid, undefined, RETURN_TO));
  eq('the signed state carries the path the wizard asked for', st?.next, RETURN_TO);
  eq('and the tenant, so the callback still knows whose connection this is', st?.tid, me.tid);
  for (const evil of ['https://evil.example/steal', '//evil.example/steal', 'welcome']) {
    // signState will carry anything; verifyState is the gate, because the state is ours and therefore trusted later.
    eq(`a state carrying ${JSON.stringify(evil)} yields no destination`, verifyState(signState(me.tid, me.uid, undefined, evil))?.next, undefined);
  }
  const stateOf = (u: string) => verifyState(new URL(u).searchParams.get('state'));
  eq('connectUrl carries the destination through Meta intact', stateOf(connectUrl('http://localhost', me.tid, me.uid, RETURN_TO))?.next, RETURN_TO);

  // Meta refusing used to dump the person on /automations, two screens short of the one that restates the charge date.
  const denied = await app.request(`/api/instagram/callback?error=access_denied&error_reason=user_denied&state=${encodeURIComponent(signState(me.tid, me.uid, undefined, RETURN_TO))}`);
  const deniedTo = denied.headers.get('location') || '';
  eq('a refusal by Meta redirects', denied.status, 302);
  check('back to the wizard screen that started it, not to /automations', deniedTo.includes('/welcome?step=4') && deniedTo.includes('error=denied') && !deniedTo.includes('/automations'), deniedTo);

  // The last chokepoint before the person leaves for Meta: hosted, app in Development mode, a stranger's tenant. Any
  // button we failed to gate, any stale tab and any bookmark used to land on Meta's "app not active" page.
  _resetIgAvailability();
  const blocked = await app.request(`/api/instagram/connect?next=${encodeURIComponent(RETURN_TO)}`, { headers: { cookie: me.cookie } });
  const blockedTo = blocked.headers.get('location') || '';
  eq('starting the connect while it cannot work does not reach Meta', blocked.status, 302);
  check('it comes back with the reason instead', blockedTo.includes('/welcome?step=4') && blockedTo.includes('error=unavailable'), blockedTo);
  check('and nothing was sent to instagram.com', !blockedTo.includes('instagram.com'), blockedTo);

  // Live app: the connect goes through, and `next` still cannot become an open redirect.
  process.env.META_APP_LIVE = 'true';
  _resetIgAvailability();
  const okConnect = await app.request(`/api/instagram/connect?next=${encodeURIComponent(RETURN_TO)}`, { headers: { cookie: me.cookie } });
  const okTo = okConnect.headers.get('location') || '';
  check('with the app Live the connect reaches Meta', okConnect.status === 302 && okTo.startsWith('https://www.instagram.com/oauth/authorize'), { status: okConnect.status, okTo });
  eq('carrying the wizard destination in the signed state', stateOf(okTo)?.next, RETURN_TO);
  const evil = await app.request('/api/instagram/connect?next=https%3A%2F%2Fevil.example%2Fsteal', { headers: { cookie: me.cookie } });
  const evilTo = evil.headers.get('location') || '';
  eq('an absolute ?next= is dropped, not honoured', stateOf(evilTo)?.next, undefined);
  check('so no redirect ever points at another host', !evilTo.includes('evil.example'), evilTo);
  delete process.env.META_APP_LIVE;
  _resetIgAvailability();
}

/* ------------------------------------------------------------------ */
section('B. removing the app on Instagram wipes the message data, as /privacy says');
{
  const me = makeTenant('deauthorizer');
  const igUser = '17841400000000101';
  seedInstagram(me.tid, igUser);
  eq('seeded', Object.values(igRowCounts(me.tid)).every((n) => n === 1), true);

  const res = await app.request('/api/instagram/deauthorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ signed_request: signedRequest({ user_id: igUser, issued_at: Math.floor(Date.now() / 1000) }) }).toString(),
  });
  const body = await res.json() as any;
  eq('Meta gets a 200 and the number of tenants touched', [res.status, body.disconnected], [200, 1]);
  // This is the callback Meta guarantees on "Remove"; the data-deletion callback is a separate request tied to a
  // deletion request. Leaving the wipe to that one meant every sender id, handle and message body of a removed
  // account stayed in the database indefinitely, while /privacy and /data-deletion said otherwise.
  eq('the token, the contacts, the events and the cached Instagram data are all gone',
    igRowCounts(me.tid), { accounts: 0, events: 0, contacts: 0, media: 0, insights: 0, snapshots: 0 });

  const other = makeTenant('bystander');
  seedInstagram(other.tid, '17841400000000102');
  await app.request('/api/instagram/deauthorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ signed_request: signedRequest({ user_id: igUser }) }).toString(),
  });
  eq('a second removal of the first account leaves everybody else alone', Object.values(igRowCounts(other.tid)).every((n) => n === 1), true);

  const forged = await app.request('/api/instagram/deauthorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ signed_request: `abc.${Buffer.from(JSON.stringify({ user_id: '17841400000000102' })).toString('base64url')}` }).toString(),
  });
  eq('an unsigned request deletes nothing', forged.status, 400);
  eq('and the bystander still has their data', Object.values(igRowCounts(other.tid)).every((n) => n === 1), true);
}

/* ------------------------------------------------------------------ */
section('C. the data-deletion callback leaves a record, not just a console line');
{
  const me = makeTenant('deleter');
  const igUser = '17841400000000103';
  seedInstagram(me.tid, igUser);

  const res = await app.request('/api/instagram/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signed_request: signedRequest({ user_id: igUser }) }),
  });
  const body = await res.json() as any;
  eq('200', res.status, 200);
  check('a confirmation code comes back', typeof body.confirmation_code === 'string' && body.confirmation_code.length > 10, body.confirmation_code);
  // Meta's contract for `url` is a page where the person can follow the request up. It used to point at /privacy,
  // which says nothing about deletion requests or confirmation codes; /data-deletion is the page that does.
  check('the status URL points at the page that describes the request', String(body.url || '').endsWith('/data-deletion'), body.url);
  const record = getMeta(me.tid, 'ig_deletion_request');
  check('and the code is stored, so support can look it up', !!record && JSON.parse(record).code === body.confirmation_code, record);
  eq('the wipe happened too', Object.values(igRowCounts(me.tid)).every((n) => n === 0), true);
}

/* ------------------------------------------------------------------ */
section('D. deleting the account cancels the subscription instead of billing a ghost');
{
  // Billing's delete panel says "cancels your subscription at Paddle". The handler used to make no Paddle call at all,
  // so a Pro subscriber kept being charged with no account left to log into and cancel from.
  const paid = makeTenant('paid-leaver');
  d.prepare("UPDATE tenants SET plan = 'pro', plan_status = 'active', paddle_customer_id = 'ctm_1', paddle_subscription_id = 'sub_ok' WHERE id = ?").run(paid.tid);
  calls.length = 0;
  paddleStatus = 200;
  const res = await app.request('/api/account', { method: 'DELETE', headers: { cookie: paid.cookie } });
  const body = await res.json() as any;
  eq('200', res.status, 200);
  eq('and it reports the subscription cancelled', body.subscription, 'canceled');
  const cancelCall = paddleCalls().find((c) => c.url.includes('/subscriptions/sub_ok/cancel'));
  check('a cancel really went to Paddle', !!cancelCall && cancelCall.method === 'POST', paddleCalls());
  check('the tenant is marked deleted', Number((d.prepare('SELECT deleted_at FROM tenants WHERE id = ?').get(paid.tid) as any).deleted_at) > 0);
  eq('and the e-mail address is gone', (d.prepare('SELECT COUNT(*) n FROM users WHERE tenant_id = ?').get(paid.tid) as any).n, 0);

  // When Paddle refuses we say so on the screen rather than reporting a cancellation that did not happen.
  const failing = makeTenant('unlucky-leaver');
  d.prepare("UPDATE tenants SET plan = 'pro', plan_status = 'active', paddle_subscription_id = 'sub_bad' WHERE id = ?").run(failing.tid);
  paddleStatus = 403;
  const res2 = await app.request('/api/account', { method: 'DELETE', headers: { cookie: failing.cookie } });
  const body2 = await res2.json() as any;
  eq('the account still goes', res2.status, 200);
  eq('but the subscription is reported as not cancelled', body2.subscription, 'cancel_failed');
  check('and the note tells them what to do about it', /hello@resurfly\.com/.test(String(body2.note || '')), body2.note);

  const free = makeTenant('free-leaver');
  calls.length = 0;
  paddleStatus = 200;
  const res3 = await app.request('/api/account', { method: 'DELETE', headers: { cookie: free.cookie } });
  const body3 = await res3.json() as any;
  eq('a tenant with no subscription needs no Paddle call', [res3.status, body3.subscription, paddleCalls().length], [200, 'none', 0]);
}

/* ------------------------------------------------------------------ */
section('E. the orphan media sweep finishes an interrupted deletion');
{
  // `DELETE /api/account` answers before the media loop is done, so a redeploy mid-loop used to leave thumbnails and
  // extracted video frames on disk with no row left to find them by — while /privacy promises those files go too.
  fs.mkdirSync(config.mediaDir, { recursive: true });
  const mk = (name: string) => { fs.mkdirSync(path.join(config.mediaDir, name), { recursive: true }); fs.writeFileSync(path.join(config.mediaDir, name, 'thumb.webp'), 'x'); };
  const there = (...p: string[]) => fs.existsSync(path.join(config.mediaDir, ...p));
  mk('t9_alive');
  mk('t9_orphan');
  mk('t9_orphan_two');
  fs.writeFileSync(path.join(config.mediaDir, 'loose-file.txt'), 'not a folder');

  const r = await sweepOrphanMedia(() => ['t9_alive']);
  eq('both orphans removed', r.removed, 2);
  check('the live item keeps its media', there('t9_alive', 'thumb.webp'));
  check('and the orphans are gone', !there('t9_orphan') && !there('t9_orphan_two'));
  check('a stray file is not a media folder and is left alone', there('loose-file.txt'));

  // The guard that matters most: a failed query, or a database not open yet, returns no ids — and deleting on that
  // reading would erase every library on the server.
  mk('t9_orphan');
  const guarded = await sweepOrphanMedia(() => []);
  eq('an empty live set removes nothing', guarded.removed, 0);
  check('every folder is still there', there('t9_alive') && there('t9_orphan'));

  // Ids are mapped through safeName before comparison, so an id holding characters a folder cannot carry still matches.
  fs.rmSync(path.join(config.mediaDir, 't9_orphan'), { recursive: true, force: true });
  mk('t9_odd_id');
  const mapped = await sweepOrphanMedia(() => ['t9/odd:id', 't9_alive']);
  eq('an id that had to be sanitised into its folder name is still live', mapped.removed, 0);
  check('so its media survives', there('t9_odd_id'));
}

console.log(failures ? `\nFAILED — ${failures} check(s) failed` : '\nall good');
process.exit(failures ? 1 : 0);
