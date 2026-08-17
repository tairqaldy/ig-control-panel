/**
 * In-process test for Instagram availability (ROUND7-SPEC §3). No test runner needed:
 *
 *   npx tsx server/src/services/ig-availability.test.ts
 *
 * Runs against a throwaway SQLite database in the OS temp directory (DATA_DIR is set before anything is imported).
 * `fetch` is replaced by a counter so the daily app probe can be observed without touching Meta. Covers: the three
 * modes, who may connect while the app is in Development mode, the capability note that goes into every Ask prompt,
 * the 10-minute cache and its invalidation, waitlist idempotency, and that the app secret never leaves the process.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resurfly-ig-avail-'));
process.env.DATA_DIR = dir;
process.env.HOSTED = 'true';
process.env.META_APP_ID = '1234567890';
process.env.META_APP_SECRET = 'app-secret-must-never-leak';
process.env.SESSION_SECRET = 'test-session-secret-value-0123456789';
process.env.AUTO_START_WORKER = 'false';
process.env.SERVER_HARVEST_ENABLED = 'false';
process.env.OPENAI_API_KEY = '';
delete process.env.META_APP_LIVE;

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

/** Stand-in for the Meta app node. `mode` decides what the next probe gets back. */
let probes = 0;
let probeMode: 'ok' | 'rejected' | 'boom' | 'ratelimit' | 'server_error' = 'ok';
const probedUrls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any) => {
  probes++;
  probedUrls.push(String(input));
  if (probeMode === 'boom') throw new Error('socket hang up');
  // Both of these arrive as `{ error: {…} }` exactly like a refusal does — which is what used to make one bad minute
  // look like "Meta rejects our app" for a full day.
  if (probeMode === 'ratelimit') {
    return new Response(JSON.stringify({ error: { message: 'Application request limit reached', type: 'OAuthException', code: 4 } }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  if (probeMode === 'server_error') {
    return new Response(JSON.stringify({ error: { message: 'An unexpected error has occurred.', type: 'OAuthException', code: 2 } }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
  const body = probeMode === 'ok'
    ? { id: '1234567890', name: 'Resurfly', link: 'https://facebook.com/games/', category: 'Utility' }
    : { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } };
  return new Response(JSON.stringify(body), { status: probeMode === 'ok' ? 200 : 400, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

async function main() {
  const { config } = await import('../config.js');
  const { db, now } = await import('../db.js');
  const { igAvailability, igAvailabilityCached, igCapabilityNote, waitlistAdd, waitlistAll, waitlistRemove, _resetIgAvailability } = await import('./ig-availability.js');

  const d = db();
  const t = now();
  const tid = Number(d.prepare("INSERT INTO tenants (name, plan, plan_status, created_at, updated_at) VALUES ('stranger', 'trial', 'active', ?, ?) ").run(t, t).lastInsertRowid);
  console.log(`tenant ${tid} (a stranger, not the owner), db at ${dir}`);
  check('a fresh tenant is not tenant 1', tid > 1, tid);

  /* ---------------- development mode: the state the product ships in ---------------- */
  console.log('\ndevelopment mode (META_APP_LIVE unset)');
  let av = await igAvailability(tid);
  eq('mode is development', av.mode, 'development');
  eq('a stranger cannot connect', av.canConnect, false);
  check('the reason names Meta\'s review', /Meta's review/.test(av.reason), av.reason);
  eq('the waitlist is offered', [av.waitlistOffered, av.waitlist], [true, false]);
  eq('the app name came from the probe', av.appName, 'Resurfly');
  eq('the probe ran once', probes, 1);
  check('the probe asked Meta for the app node', probedUrls[0].includes('graph.facebook.com') && probedUrls[0].includes('/1234567890'), probedUrls[0].split('access_token=')[0]);

  /* ---------------- the capability note that goes into every Ask prompt ---------------- */
  console.log('\ncapability note');
  const note = igCapabilityNote(tid);
  check('the note forbids recommending a connection', /Never tell them to connect Instagram/.test(note), note);
  check('the note points at the library instead', /library of saves/.test(note), note);
  check('the note carries the reason', note.includes(av.reason), note);

  /* ---------------- the owner tenant holds the tester role ---------------- */
  console.log('\nthe owner tenant');
  const owner = await igAvailability(1);
  eq('the owner can connect in development mode', [owner.canConnect, owner.mode], [true, 'development']);
  check('the owner reason explains the tester role', /tester or admin role/.test(owner.reason), owner.reason);
  check('the owner note does not forbid connecting', !/Never tell them to connect/.test(owner.note), owner.note);

  /* ---------------- caching ---------------- */
  console.log('\ncaching');
  await igAvailability(tid);
  await igAvailability(tid);
  igAvailabilityCached(tid);
  eq('10 minutes of answers cost one probe', probes, 1);

  /* ---------------- waitlist ---------------- */
  console.log('\nwaitlist');
  const first = waitlistAdd(tid, 'stranger@example.com', 'onboarding');
  const again = waitlistAdd(tid, 'stranger@example.com', 'onboarding');
  eq('the second ask is recognised as a repeat', [first.alreadyOn, again.alreadyOn], [false, true]);
  eq('one row per tenant', (d.prepare('SELECT COUNT(*) AS n FROM ig_waitlist WHERE tenant_id = ?').get(tid) as any).n, 1);
  av = await igAvailability(tid);
  eq('availability shows them on the list right away', [av.waitlist, av.waitlistEmail], [true, 'stranger@example.com']);
  eq('the pending list has them', waitlistAll().map((r) => r.email), ['stranger@example.com']);
  eq('they can be taken off again', [waitlistRemove(tid), (await igAvailability(tid)).waitlist], [true, false]);

  /* ---------------- live mode ---------------- */
  console.log('\nlive mode (META_APP_LIVE=true)');
  process.env.META_APP_LIVE = 'true';
  _resetIgAvailability({ probe: false }); // the app node answer is unchanged; only our own flag moved
  av = await igAvailability(tid);
  eq('mode is live and a stranger can connect', [av.mode, av.canConnect], ['live', true]);
  eq('nothing to wait for', av.waitlistOffered, false);
  check('the note invites a connection when it works', /has not connected their Instagram account yet/.test(av.note), av.note);

  /* ---------------- Meta refuses the probe ---------------- */
  /*
   * A refused probe used to force canConnect=false for everybody. That was wrong for the configuration we actually
   * run: META_APP_ID is an Instagram (Instagram Login) app id, and graph.facebook.com/{id} only resolves a Facebook
   * Application node, so Meta refuses the lookup on every correctly configured Instagram-Login deployment. On
   * production it made the site tell the owner — who could demonstrably connect — "Meta is not accepting our app's
   * credentials", and injected that into every Ask prompt. META_APP_LIVE is the authority on live-vs-development;
   * the probe is a diagnostic.
   */
  console.log('\nMeta refuses the app probe');
  probeMode = 'rejected';
  _resetIgAvailability();
  av = await igAvailability(tid, { force: true });
  eq('a refused probe does not override META_APP_LIVE', [av.mode, av.canConnect], ['live', true]);
  eq('nothing to wait for while the app is live', av.waitlistOffered, false);
  check('the raw Meta error is not shown to a hosted stranger', !av.reason.includes('Invalid OAuth access token.'), av.reason);
  check('the secret is nowhere in the payload', !JSON.stringify(av).includes(process.env.META_APP_SECRET!), av.reason);

  console.log('\nMeta refuses the app probe, self-hosted (the operator can act on it)');
  (config as any).hosted = false;
  _resetIgAvailability();
  av = await igAvailability(tid, { force: true });
  eq('the self-hoster can still connect', [av.mode, av.canConnect], ['live', true]);
  check("Meta's own words are surfaced to whoever can act on them", av.reason.includes('Invalid OAuth access token.'), av.reason);
  check('and framed as a check, not a breakage', /does not block connecting/.test(av.reason), av.reason);
  eq('nothing to put them on a waitlist for', av.waitlistOffered, false);
  (config as any).hosted = true;

  console.log('\nno Meta app at all is the only state that closes the door');
  const savedAppId = config.metaAppId;
  (config as any).metaAppId = '';
  _resetIgAvailability();
  av = await igAvailability(tid, { force: true });
  eq('unconfigured: no mode, no connect', [av.mode, av.canConnect], ['unconfigured', false]);
  eq('and no waitlist, because nobody is coming to fix it for them', av.waitlistOffered, false);
  (config as any).metaAppId = savedAppId;

  /* ---------------- Meta unreachable: the verdict must not flip on a network blip ---------------- */
  console.log('\nMeta unreachable');
  probeMode = 'boom';
  _resetIgAvailability();
  av = await igAvailability(tid, { force: true });
  eq('an unreachable Meta leaves the flag in charge', [av.mode, av.canConnect], ['live', true]);

  /* ---------------- no Meta app configured at all (self-hoster who never set one up) ---------------- */
  console.log('\nno Meta app configured');
  (config as any).metaAppId = '';
  (config as any).metaAppSecret = '';
  _resetIgAvailability();
  const before = probes;
  av = await igAvailability(tid);
  eq('mode is unconfigured', [av.mode, av.canConnect, av.configured], ['unconfigured', false, false]);
  eq('nothing is asked of Meta', probes, before);
  check('the reason says there is no app', /no Meta app configured/.test(av.reason), av.reason);

  /* ---------------- the endpoints, through the real app ---------------- */
  console.log('\nGET /api/instagram/availability · POST /api/instagram/waitlist');
  (config as any).metaAppId = '1234567890';
  (config as any).metaAppSecret = process.env.META_APP_SECRET;
  delete process.env.META_APP_LIVE;
  probeMode = 'ok';
  _resetIgAvailability();

  const { createApp } = await import('../app.js');
  const { createSessionToken } = await import('../auth.js');
  const uid = Number(d.prepare('INSERT INTO users (tenant_id, email, password_hash, is_owner, created_at) VALUES (?, ?, NULL, 0, ?)').run(tid, 'stranger@example.com', t).lastInsertRowid);
  const cookie = `rs_session=${createSessionToken('stranger@example.com', tid, uid)}`;
  const app = createApp();
  const call = (p: string, init: RequestInit = {}) => app.request(p, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers || {}) } });

  const res = await call('/api/instagram/availability');
  const payload = await res.json() as Record<string, unknown>;
  eq('availability answers 200', res.status, 200);
  eq('the shape the web agents code against', [payload.canConnect, payload.mode, typeof payload.reason, payload.waitlist], [false, 'development', 'string', false]);
  eq('every field the onboarding and automations hooks read', ['canConnect', 'mode', 'reason', 'waitlist', 'connected', 'username'].filter((k) => !(k in payload)), []);

  const wl = await call('/api/instagram/waitlist', { method: 'POST', body: JSON.stringify({ source: 'onboarding' }) });
  const wlBody = await wl.json() as Record<string, any>;
  eq('the waitlist falls back to the account e-mail', [wl.status, wlBody.ok, wlBody.email], [200, true, 'stranger@example.com']);
  const bad = await call('/api/instagram/waitlist', { method: 'POST', body: JSON.stringify({ email: 'not-an-address' }) });
  eq('a malformed address is refused', bad.status, 400);
  // A customer must not be able to read the list they are on: `isOwner` is the deployment's admin login only.
  const forbidden = await call('/api/instagram/waitlist/pending');
  eq('the pending list is owner only', forbidden.status, 403);

  const off = await call('/api/instagram/waitlist', { method: 'DELETE' });
  eq('and they can come off again', [off.status, (await off.json() as any).removed], [200, true]);

  /* ---------------- fix pass: a bad minute at Meta is not a bad day for everyone ---------------- */
  console.log('\na transient Meta error does not close the door');
  (config as any).hosted = true;
  process.env.META_APP_LIVE = 'true';
  for (const mode of ['ratelimit', 'server_error'] as const) {
    probeMode = mode;
    _resetIgAvailability();
    const t1 = await igAvailability(tid, { force: true });
    // Classifying a rate limit as a refusal forced canConnect false for every tenant of a Live, working app, put
    // "this person cannot connect an Instagram account" into every Ask prompt, and — because the probe TTL ignored
    // status — held that for 24 hours, recoverable only by restarting the server.
    eq(`${mode}: the verdict is unchanged`, [t1.mode, t1.canConnect], ['live', true]);
    check(`${mode}: and the note does not tell the AI to stop suggesting it`, /has not connected their Instagram account yet/.test(t1.note), t1.note);
  }

  probeMode = 'rejected';
  _resetIgAvailability();
  const refused = await igAvailability(tid, { force: true });
  eq('a refusal is a diagnostic, not a door — the verdict is unchanged', [refused.mode, refused.canConnect], ['live', true]);

  /* ---------------- fix pass: connect / disconnect invalidate the tenant cache ---------------- */
  console.log('\nthe capability note follows a connection immediately');
  const { invalidateIgAvailability } = await import('./ig-availability.js');
  probeMode = 'ok';
  _resetIgAvailability();
  const beforeConnect = igAvailabilityCached(tid);
  eq('not connected, and cached as such', beforeConnect.connected, false);
  d.prepare("INSERT INTO ig_accounts (tenant_id, ig_user_id, username, access_token_enc, connected_at) VALUES (?, '17841400000000009', 'freshly_connected', 'x', ?)").run(tid, now());
  check('the cache still says not connected (10-minute TTL)', !igAvailabilityCached(tid).connected);
  invalidateIgAvailability(tid);
  const afterConnect = igAvailabilityCached(tid);
  eq('after invalidation it knows', afterConnect.connected, true);
  // Without this the assistant spends ten minutes telling somebody who has just connected to go and connect.
  check('and the AI note stops telling them to connect', /is connected/.test(afterConnect.note), afterConnect.note);
  d.prepare('DELETE FROM ig_accounts WHERE tenant_id = ?').run(tid);
  invalidateIgAvailability(tid);
  eq('and it follows a disconnect too', igAvailabilityCached(tid).connected, false);

  globalThis.fetch = realFetch;
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
