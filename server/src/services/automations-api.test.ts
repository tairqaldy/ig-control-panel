/**
 * In-process test for ROUND6 §1 (server-automations). No ports, no network: the Graph API is mocked on globalThis.fetch
 * and the app is driven with `app.request`. Runs against a COPY of ./data so migration 007 is exercised on real data.
 *
 *   npx tsx <this file>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');   // server/src/services → repo root
const SRC = path.join(REPO, 'data');
const DEST = fs.mkdtempSync(path.join(os.tmpdir(), 'resurfly-round6-'));

/* ---------- 1. work on a COPY of ./data when there is one, so migration 007 meets a real database ---------- */
if (fs.existsSync(SRC)) {
  for (const f of fs.readdirSync(SRC)) {
    const p = path.join(SRC, f);
    if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(DEST, f));
  }
  console.log(`[setup] copied ${SRC} → ${DEST}`);
} else {
  console.log(`[setup] no ./data in this checkout — running against a fresh database at ${DEST}`);
}

/* ---------- 2. env BEFORE importing anything from the server ---------- */
process.env.DATA_DIR = DEST;
process.env.NODE_ENV = 'test';
process.env.AUTO_START_WORKER = 'false';
process.env.SERVER_HARVEST_ENABLED = 'false';
process.env.APP_USERNAME = 'owner@example.com';
process.env.SESSION_SECRET = 'test-session-secret-value-0123456789';
process.env.HOSTED = 'true';
process.env.META_APP_ID = 'test-app-id';
process.env.META_APP_SECRET = 'test-app-secret';
process.env.META_VERIFY_TOKEN = 'test-verify-token';
process.env.IG_ACCESS_TOKEN = '';
process.env.IG_USER_ID = '';
process.env.OPENAI_API_KEY = '';

/* ---------- 3. Graph API mock ---------- */
const IG_USER = '17841400000000001';
interface MockState {
  meError: any | null;
  subscribedFields: string[] | null; // null = no subscription rows
  sendError: any | null;
  media: any[];
  mediaError: any | null;
  calls: string[];
}
const mock: MockState = {
  meError: null,
  subscribedFields: ['messages', 'comments', 'message_reactions', 'messaging_postbacks', 'messaging_seen'],
  sendError: null,
  media: [
    { id: 'MEDIA_A', caption: 'Reel about hooks', media_type: 'VIDEO', media_product_type: 'REELS', media_url: 'https://cdn/a.mp4', thumbnail_url: 'https://cdn/a.jpg', permalink: 'https://instagram.com/p/a', timestamp: '2026-08-01T10:00:00+0000', like_count: 120, comments_count: 8 },
    { id: 'MEDIA_B', caption: 'Carousel about editing', media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED', media_url: 'https://cdn/b.jpg', thumbnail_url: null, permalink: 'https://instagram.com/p/b', timestamp: '2026-07-20T10:00:00+0000', like_count: 90, comments_count: 3 },
  ],
  mediaError: null,
  calls: [],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
  const method = (init?.method || 'GET').toUpperCase();
  const p = url.pathname;
  mock.calls.push(`${method} ${p}`);
  if (/\/me$/.test(p)) return mock.meError ? json({ error: mock.meError }, 400) : json({ id: IG_USER, user_id: IG_USER, username: 'testcreator', name: 'Test Creator' });
  if (/\/subscribed_apps$/.test(p)) {
    if (method === 'POST') { mock.subscribedFields = ['messages', 'comments', 'message_reactions', 'messaging_postbacks', 'messaging_seen']; return json({ success: true }); }
    return json({ data: mock.subscribedFields ? [{ subscribed_fields: mock.subscribedFields }] : [] });
  }
  if (/\/messages$/.test(p)) return mock.sendError ? json({ error: mock.sendError }, 400) : json({ recipient_id: 'SENDER_1', message_id: 'mid.test' });
  if (/\/replies$/.test(p)) return json({ id: 'reply.1' });
  if (/\/media$/.test(p)) return mock.mediaError ? json({ error: mock.mediaError }, 400) : json({ data: mock.media });
  return json({ data: [] });
}) as typeof fetch;

/* ---------- 4. imports (after env + fetch) ---------- */
const mod = (rel: string) => pathToFileURL(path.join(REPO, rel)).href;
const { createApp } = await import(mod('server/src/app.ts'));
const { db, now, setSetting } = await import(mod('server/src/db.ts'));
const { createSessionToken } = await import(mod('server/src/auth.ts'));
const { encryptSecret } = await import(mod('server/src/services/crypto.ts'));
const auto = await import(mod('server/src/services/automations.ts'));

/* ---------- tiny assert harness ---------- */
let pass = 0; const failures: string[] = [];
function check(name: string, cond: unknown, extra?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${extra !== undefined ? ` → ${JSON.stringify(extra)}` : ''}`); }
}
const section = (s: string) => console.log(`\n=== ${s} ===`);

/* ---------- 5. fixture tenant ---------- */
const d = db();
const ts = now();
const tenantId = Number(d.prepare("INSERT INTO tenants (name, plan, plan_status, created_at, updated_at) VALUES ('round6 test', 'pro', 'active', ?, ?)").run(ts, ts).lastInsertRowid);
const userId = Number(d.prepare('INSERT INTO users (tenant_id, email, password_hash, is_owner, created_at) VALUES (?, ?, NULL, 0, ?)').run(tenantId, `round6-${ts}@example.com`, ts).lastInsertRowid);
const cookie = `rs_session=${createSessionToken(`round6-${ts}@example.com`, tenantId, userId)}`;

const app = createApp();
const get = (p: string) => app.request(p, { headers: { cookie } });
const post = (p: string, body?: unknown) => app.request(p, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const put = (p: string, body?: unknown) => app.request(p, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

function connect(connectedAgo = 3600) {
  d.prepare(`INSERT INTO ig_accounts (tenant_id, ig_user_id, username, access_token_enc, scopes, connected_at, webhook_subscribed) VALUES (?, ?, 'testcreator', ?, ?, ?, 1)
    ON CONFLICT(tenant_id) DO UPDATE SET connected_at = excluded.connected_at`)
    .run(tenantId, IG_USER, encryptSecret('TEST_TOKEN', 'ig'), 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments', now() - connectedAgo);
  setSetting(tenantId, 'ig_user_id', IG_USER);
  setSetting(tenantId, 'ig_access_token', 'TEST_TOKEN');
}
function disconnect() {
  d.prepare('DELETE FROM ig_accounts WHERE tenant_id = ?').run(tenantId);
  setSetting(tenantId, 'ig_user_id', null);
  setSetting(tenantId, 'ig_access_token', null);
}
const checkOf = (payload: any, id: string) => payload.checks.find((c: any) => c.id === id);
const wipeEvents = () => d.prepare('DELETE FROM automation_events WHERE tenant_id = ?').run(tenantId);
const wipeContacts = () => d.prepare('DELETE FROM automation_contacts WHERE tenant_id = ?').run(tenantId);
const wipeRules = () => d.prepare('DELETE FROM automation_rules WHERE tenant_id = ?').run(tenantId);

/* ---------- A. migration ---------- */
section('A. migration 007 on a copy of ./data');
{
  const applied = d.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r: any) => r.id);
  check('migration 7 applied', applied.includes(7), applied);
  const cols = (d.prepare('PRAGMA table_info(automation_rules)').all() as any[]).map((c) => c.name);
  for (const col of ['media_ids', 'once_per_person', 'last_error', 'last_error_at']) check(`automation_rules.${col} exists`, cols.includes(col), cols);
  const existing = d.prepare('SELECT COUNT(*) AS n FROM automation_rules').get() as any;
  check('existing rules survived the migration', typeof existing.n === 'number', existing);
}

/* ---------- B. diagnostics: not connected ---------- */
section('B. diagnostics — not connected');
{
  disconnect();
  const r = await get('/api/automations/diagnostics');
  const p: any = await r.json();
  check('200', r.status === 200, r.status);
  check('7 checks', p.checks.length === 7, p.checks.map((c: any) => c.id));
  check('connected = fail', checkOf(p, 'connected').status === 'fail');
  check('connected fix href', checkOf(p, 'connected').fix?.href === '/api/instagram/connect');
  check('permissions = fail', checkOf(p, 'permissions').status === 'fail');
  check('webhook_subscribed = fail', checkOf(p, 'webhook_subscribed').status === 'fail');
  check('messaging_window = ok', checkOf(p, 'messaging_window').status === 'ok');
  check('canFire = false', p.canFire === false);
  check('summary counts add up', p.summary.ok + p.summary.warn + p.summary.fail === 7, p.summary);
}

/* ---------- C. diagnostics: connected, no inbound events ---------- */
section('C. diagnostics — connected, no inbound event ever (app_published warning)');
{
  connect(3600);
  wipeEvents();
  const p: any = await (await get('/api/automations/diagnostics')).json();
  check('connected = ok', checkOf(p, 'connected').status === 'ok', checkOf(p, 'connected'));
  check('permissions = ok', checkOf(p, 'permissions').status === 'ok', checkOf(p, 'permissions'));
  check('webhook_subscribed = ok', checkOf(p, 'webhook_subscribed').status === 'ok', checkOf(p, 'webhook_subscribed'));
  const ap = checkOf(p, 'app_published');
  check('app_published = warn', ap.status === 'warn', ap);
  check('app_published explains Live mode', /Live/.test(ap.detail) && /Development mode/.test(ap.detail), ap.detail);
  check('app_published fix links to the doc', /AUTOMATIONS\.md#.*live/.test(ap.fix?.href || ''), ap.fix);
  check('rules_enabled = warn (no rules yet)', checkOf(p, 'rules_enabled').status === 'warn', checkOf(p, 'rules_enabled'));
  check('lastInboundAt null', p.lastInboundAt === null, p.lastInboundAt);
}

/* ---------- C2. token rejected + subscription missing ---------- */
section('C2. diagnostics — Instagram rejects the token / no subscription');
{
  mock.meError = { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190 };
  mock.subscribedFields = null;
  const p: any = await (await get('/api/automations/diagnostics')).json();
  const perm = checkOf(p, 'permissions');
  check('permissions = fail', perm.status === 'fail', perm);
  check('OAuthException surfaced verbatim', perm.detail.includes('Session has expired') && perm.detail.includes('OAuthException'), perm.detail);
  const wh = checkOf(p, 'webhook_subscribed');
  check('webhook = fail with resubscribe action', wh.status === 'fail' && wh.fix?.action === 'resubscribe', wh);
  mock.meError = null;
}

/* ---------- C3. resubscribe ---------- */
section('C3. POST /api/automations/resubscribe');
{
  const r = await post('/api/automations/resubscribe');
  const p: any = await r.json();
  check('200 ok', r.status === 200 && p.ok === true, p);
  check('returns Meta\'s raw subscription', Array.isArray((p.response as any)?.data), p.response);
  check('fields listed', p.fields.includes('messages') && p.fields.includes('comments'), p.fields);
  const after: any = await (await get('/api/automations/diagnostics')).json();
  check('webhook check now ok', checkOf(after, 'webhook_subscribed').status === 'ok', checkOf(after, 'webhook_subscribed'));
}

/* ---------- D. rules + simulate ---------- */
section('D. rules CRUD carries media_ids / once_per_person, simulate matches');
let commentRuleId = 0;
{
  wipeRules();
  const created: any = await (await post('/api/automations/rules', {
    name: 'Comment → link', trigger_type: 'comment_keyword', match_mode: 'contains', keywords: ['link'],
    reply_text: 'Here it is, {{username}}', reply_link: 'https://resurfly.com', public_reply_text: 'Sent!', cooldown_minutes: 0,
  })).json();
  commentRuleId = created.rule.id;
  check('rule created', !!commentRuleId, created);
  check('media_ids defaults to null (every post)', created.rule.media_ids === null, created.rule.media_ids);
  check('once_per_person defaults to 0', created.rule.once_per_person === 0, created.rule.once_per_person);

  const sim1: any = await (await post('/api/automations/simulate', { kind: 'comment', text: 'can you send the link?', mediaId: 'MEDIA_A', senderUsername: 'friend' })).json();
  check('comment rule matches without media filter', sim1.matched?.ruleId === commentRuleId, sim1);
  check('wouldSend.dm renders {{username}}', sim1.wouldSend.dm?.includes('@friend'), sim1.wouldSend);
  check('wouldSend.publicReply present', sim1.wouldSend.publicReply === 'Sent!', sim1.wouldSend);

  const sim0: any = await (await post('/api/automations/simulate', { kind: 'comment', text: 'nice post', mediaId: 'MEDIA_A' })).json();
  check('no keyword → no match', sim0.matched === null, sim0);
  check('skip reason names the keywords', /keywords \(link\)/.test(sim0.skipped[0]?.reason || ''), sim0.skipped);

  // now limit the rule to MEDIA_B
  const upd: any = await (await put(`/api/automations/rules/${commentRuleId}`, { media_ids: ['MEDIA_B'], once_per_person: true })).json();
  check('media_ids persisted', upd.rule.media_ids === '["MEDIA_B"]', upd.rule.media_ids);
  check('once_per_person persisted', upd.rule.once_per_person === 1, upd.rule.once_per_person);

  const simB: any = await (await post('/api/automations/simulate', { kind: 'comment', text: 'link please', mediaId: 'MEDIA_B' })).json();
  check('matches on a selected post', simB.matched?.ruleId === commentRuleId, simB);
  const simA: any = await (await post('/api/automations/simulate', { kind: 'comment', text: 'link please', mediaId: 'MEDIA_A' })).json();
  check('skipped on another post', simA.matched === null, simA);
  check('skip reason mentions the post filter', /selected post/.test(simA.skipped[0]?.reason || ''), simA.skipped);
  const simNone: any = await (await post('/api/automations/simulate', { kind: 'comment', text: 'link please' })).json();
  check('skipped when the comment carries no post id', simNone.matched === null && /no post id/.test(simNone.skipped[0]?.reason || ''), simNone.skipped);
}

/* ---------- E. engine: media filter, once_per_person, dm_first, no_match ---------- */
section('E. engine — handleIncoming');
{
  wipeEvents(); wipeContacts();
  // comment on the wrong post → no match, logged with a reason
  const r1 = await auto.handleIncoming(tenantId, { kind: 'comment', text: 'link please', senderId: 'SENDER_1', senderUsername: 'friend', commentId: 'C1', mediaId: 'MEDIA_A' });
  check('no rule matched on the wrong post', r1.matched === null, r1.actions);
  const ev1 = d.prepare('SELECT * FROM automation_events WHERE tenant_id = ? ORDER BY id DESC LIMIT 1').get(tenantId) as any;
  check('inbound event logged with status no_match', ev1.status === 'no_match', ev1.status);
  check('no_match row explains why', /No rule matched/.test(ev1.error || '') && /selected post/.test(ev1.error || ''), ev1.error);
  check('payload snippet stored', JSON.parse(ev1.payload).snippet === 'link please', ev1.payload);

  // comment on the selected post → matches, sends
  const r2 = await auto.handleIncoming(tenantId, { kind: 'comment', text: 'link please', senderId: 'SENDER_2', senderUsername: 'buyer', commentId: 'C2', mediaId: 'MEDIA_B' });
  check('matched on the selected post', r2.matched?.id === commentRuleId, r2.actions);
  check('private reply sent', r2.actions.includes('private reply sent'), r2.actions);
  const ev2 = d.prepare("SELECT * FROM automation_events WHERE tenant_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1").get(tenantId) as any;
  check('inbound row settled as matched with rule id', ev2.status === 'matched' && ev2.rule_id === commentRuleId, { s: ev2.status, r: ev2.rule_id });

  // same person again → once_per_person skips
  const r3 = await auto.handleIncoming(tenantId, { kind: 'comment', text: 'link please', senderId: 'SENDER_2', senderUsername: 'buyer', commentId: 'C3', mediaId: 'MEDIA_B' });
  check('once_per_person skips the second time', r3.matched === null, r3.actions);
  const ev3 = d.prepare("SELECT * FROM automation_events WHERE tenant_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1").get(tenantId) as any;
  check('reason says once per person', /once per person/.test(ev3.error || ''), ev3.error);
}

/* ---------- F. dm_first ---------- */
section('F. dm_first trigger');
{
  wipeRules(); wipeEvents(); wipeContacts();
  const created: any = await (await post('/api/automations/rules', { name: 'First DM → welcome', trigger_type: 'dm_first', keywords: [], reply_text: 'Hey {{username}}, thanks for the first message.', cooldown_minutes: 0 })).json();
  const firstRuleId = created.rule.id;
  const a = await auto.handleIncoming(tenantId, { kind: 'dm', text: 'hi there', senderId: 'SENDER_9', senderUsername: 'newperson' });
  check('first message matches dm_first', a.matched?.id === firstRuleId, a.actions);
  check('dm sent', a.actions.includes('dm sent'), a.actions);
  const b = await auto.handleIncoming(tenantId, { kind: 'dm', text: 'hi again', senderId: 'SENDER_9', senderUsername: 'newperson' });
  check('second message does not match dm_first', b.matched === null, b.actions);
  const ev = d.prepare("SELECT * FROM automation_events WHERE tenant_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1").get(tenantId) as any;
  check('reason says not their first message', /not their first message/.test(ev.error || ''), ev.error);
  const sim: any = await (await post('/api/automations/simulate', { kind: 'dm', text: 'anything' })).json();
  check('simulate treats an unknown sender as a first message', sim.matched?.ruleId === firstRuleId, sim);
}

/* ---------- G. no rules at all ---------- */
section('G. no rules at all');
{
  wipeRules(); wipeEvents(); wipeContacts();
  const r = await auto.handleIncoming(tenantId, { kind: 'dm', text: 'hello?', senderId: 'SENDER_X' });
  check('no match', r.matched === null);
  const ev = d.prepare("SELECT * FROM automation_events WHERE tenant_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1").get(tenantId) as any;
  check('logged as no_match', ev.status === 'no_match', ev.status);
  check('reason says there are no rules', /no automation rules/i.test(ev.error || ''), ev.error);
}

/* ---------- H. test-send surfaces Meta's error ---------- */
section('H. POST /api/automations/rules/:id/test-send');
{
  wipeRules();
  const created: any = await (await post('/api/automations/rules', { name: 'DM keyword', trigger_type: 'dm_keyword', keywords: ['guide'], reply_text: 'Here you go, {{username}}.', cooldown_minutes: 0 })).json();
  const ruleId = created.rule.id;

  mock.sendError = { message: 'This person isn\'t available right now.', type: 'OAuthException', code: 10, error_subcode: 2534014 };
  const bad = await post(`/api/automations/rules/${ruleId}/test-send`, { recipient: 'SENDER_1' });
  const badBody: any = await bad.json();
  check('answers 200 with ok:false', bad.status === 200 && badBody.ok === false, { s: bad.status, b: badBody });
  check('Meta\'s message verbatim (no wrapper text)', badBody.error === 'This person isn\'t available right now.', badBody.error);
  const rule: any = d.prepare('SELECT last_error, last_error_at FROM automation_rules WHERE id = ?').get(ruleId);
  check('last_error stored on the rule', rule.last_error === 'This person isn\'t available right now.' && !!rule.last_error_at, rule);
  const errEv = d.prepare("SELECT * FROM automation_events WHERE tenant_id = ? AND status = 'error' ORDER BY id DESC LIMIT 1").get(tenantId) as any;
  check('attempt logged against the rule', errEv?.rule_id === ruleId && errEv.error === 'This person isn\'t available right now.', errEv);

  const diag: any = await (await get('/api/automations/diagnostics')).json();
  check('rules check reports the recent failure', /last failed/.test(checkOf(diag, 'rules_enabled').detail), checkOf(diag, 'rules_enabled'));

  mock.sendError = null;
  const good = await post(`/api/automations/rules/${ruleId}/test-send`, { recipient: 'SENDER_1' });
  const goodBody: any = await good.json();
  check('successful send returns ok:true and the text', goodBody.ok === true && goodBody.text.includes('@testcreator') === false && goodBody.text.startsWith('Here you go'), goodBody);
  const cleared: any = d.prepare('SELECT last_error FROM automation_rules WHERE id = ?').get(ruleId);
  check('last_error cleared after a good send', cleared.last_error === null, cleared);

  const missing = await post('/api/automations/rules/999999/test-send', { recipient: 'SENDER_1' });
  check('unknown rule → 404', missing.status === 404, missing.status);
}

/* ---------- I. diagnostics with events ---------- */
section('I. diagnostics — connected with events');
{
  const p: any = await (await get('/api/automations/diagnostics')).json();
  check('app_published = ok once events exist', checkOf(p, 'app_published').status === 'ok', checkOf(p, 'app_published'));
  check('rules_enabled = ok/warn with a rule on', ['ok', 'warn'].includes(checkOf(p, 'rules_enabled').status));
  check('sends_quota reports the Pro allowance', /5000/.test(checkOf(p, 'sends_quota').detail), checkOf(p, 'sends_quota').detail);
  check('lastOutboundAt set', typeof p.lastOutboundAt === 'number', p.lastOutboundAt);
  check('events24h > 0', p.events24h > 0, p.events24h);
  check('canFire true', p.canFire === true, p.checks.filter((c: any) => c.status === 'fail'));
  check('every detail is a sentence', p.checks.every((c: any) => typeof c.detail === 'string' && c.detail.length > 20 && /[.!]$/.test(c.detail.trim())), p.checks.map((c: any) => c.detail));
}

/* ---------- J. GET /api/instagram/media ---------- */
section('J. GET /api/instagram/media (post picker)');
{
  const r = await get('/api/instagram/media');
  const p: any = await r.json();
  check('200', r.status === 200, r.status);
  check('media returned newest first', p.media[0]?.id === 'MEDIA_A' && p.media[1]?.id === 'MEDIA_B', p.media);
  check('thumb falls back to media_url', p.media[1].thumb === 'https://cdn/b.jpg', p.media[1]);
  check('shape as specced', ['id', 'caption', 'type', 'productType', 'thumb', 'permalink', 'timestamp', 'likes', 'comments'].every((k) => k in p.media[0]), Object.keys(p.media[0]));
  check('refreshedAt set', typeof p.refreshedAt === 'number', p.refreshedAt);
  check('not stale', p.stale === false && p.error === null, p);

  const before = mock.calls.length;
  await get('/api/instagram/media');
  check('cached within 6 h (no extra Graph call)', !mock.calls.slice(before).some((c) => c.endsWith('/media')), mock.calls.slice(before));

  mock.mediaError = { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190 };
  const stale = await get('/api/instagram/media?refresh=1');
  const sp: any = await stale.json();
  check('expired token still returns the cache', stale.status === 200 && sp.media.length === 2, sp.media?.length);
  check('stale flag + verbatim error', sp.stale === true && /Session has expired/.test(sp.error || ''), sp.error);
  mock.mediaError = null;

  disconnect();
  const dis = await get('/api/instagram/media');
  const dp: any = await dis.json();
  check('disconnected → cache + connected:false, no 404', dis.status === 200 && dp.connected === false && dp.media.length === 2, dp);
  connect(3600);
}

/* ---------- K. the existing webhook must keep working ---------- */
section('K. POST /api/webhooks/instagram (signature + tenant routing + engine)');
{
  const crypto = await import('node:crypto');
  wipeRules(); wipeEvents(); wipeContacts();
  const created: any = await (await post('/api/automations/rules', { name: 'Comment any → DM', trigger_type: 'comment_any', keywords: [], reply_text: 'Thanks {{username}}', cooldown_minutes: 0 })).json();
  const body = JSON.stringify({
    object: 'instagram',
    entry: [{ id: IG_USER, time: Date.now(), changes: [{ field: 'comments', value: { id: 'C_WEBHOOK_1', text: 'love this', from: { id: 'SENDER_W', username: 'watcher' }, media: { id: 'MEDIA_A' } } }] }],
  });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'test-app-secret').update(body, 'utf8').digest('hex');

  const bad = await app.request('/api/webhooks/instagram', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' }, body });
  check('bad signature rejected', bad.status === 401, bad.status);

  const ok = await app.request('/api/webhooks/instagram', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body });
  check('signed webhook accepted', ok.status === 200 && (await ok.text()) === 'EVENT_RECEIVED', ok.status);
  await new Promise((r) => setTimeout(r, 60)); // the handler processes events after responding
  const inbound = d.prepare("SELECT * FROM automation_events WHERE tenant_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1").get(tenantId) as any;
  check('routed to the right tenant and matched', inbound?.status === 'matched' && inbound.rule_id === created.rule.id, inbound);
  const out = d.prepare("SELECT * FROM automation_events WHERE tenant_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1").get(tenantId) as any;
  check('reply sent through the engine', out?.status === 'ok' && /Thanks @watcher/.test(out.text || ''), out);

  const verify = await app.request('/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=12345');
  check('GET handshake still answers the challenge', verify.status === 200 && (await verify.text()) === '12345', verify.status);

  const legacy = await post('/api/automations/test', { kind: 'dm', text: 'love this' });
  check('legacy /automations/test still answers', legacy.status === 200, legacy.status);
  const status = await get('/api/automations/status');
  check('legacy /automations/status still answers', status.status === 200, status.status);
}

/* ---------- done ---------- */
console.log(`\n${failures.length ? 'FAILED' : 'PASSED'} — ${pass} checks passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); }
process.exit(failures.length ? 1 : 0);
