/**
 * In-process test for the automations engine (ROUND6-SPEC §1). No test runner needed:
 *
 *   npx tsx server/src/services/automations.test.ts
 *
 * Runs against a throwaway SQLite database in the OS temp directory (DATA_DIR is set before anything is imported),
 * so it never touches ./data. Nothing here calls Instagram — parsing, matching and signing are all local.
 *
 * Covers the two things that made the founder's story-reply rule look broken: the webhook envelope Meta's dashboard
 * "Test" button uses (`changes` with field `messages`, not `messaging`), and the fact that a rule can decline to fire
 * for six different reasons that were previously invisible.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resurfly-automations-'));
process.env.DATA_DIR = dir;
process.env.HOSTED = 'true';
process.env.OPENAI_API_KEY = 'sk-test-not-used';
process.env.META_APP_SECRET = '';
process.env.META_VERIFY_TOKEN = '';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

const IG_USER = '17841400000000001';   // the tenant's own Instagram account
const FAN = '9988776655';              // someone writing in
const APP_SECRET = 'test-app-secret';

async function main() {
  const { db, now, setSetting } = await import('../db.js');
  const {
    evaluateRules, matches, parseWebhookBody, ruleMediaIds, tenantsForWebhook, triggerApplies, verifySignature,
  } = await import('./automations.js');

  const d = db();
  const t = now();
  const tid = Number(d.prepare("INSERT INTO tenants (name, plan, plan_status, created_at, updated_at) VALUES ('test', 'pro', 'active', ?, ?)").run(t, t).lastInsertRowid);
  setSetting(tid, 'ig_user_id', IG_USER);
  setSetting(tid, 'ig_access_token', 'IGQV-test-token');
  setSetting(tid, 'meta_app_secret', APP_SECRET);
  console.log(`tenant ${tid}, db at ${dir}`);

  const addRule = (r: Partial<Record<string, unknown>> & { name: string; trigger_type: string }) => {
    const ts = now();
    return Number(d.prepare(`INSERT INTO automation_rules
      (tenant_id, name, enabled, trigger_type, match_mode, keywords, reply_text, reply_link, public_reply_text, cooldown_minutes, priority, media_ids, once_per_person, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      tid, r.name, r.enabled === undefined ? 1 : r.enabled, r.trigger_type, r.match_mode || 'contains',
      JSON.stringify(r.keywords || []), r.reply_text || 'Sent!', r.reply_link || null, r.public_reply_text || null,
      r.cooldown_minutes === undefined ? 1440 : r.cooldown_minutes, r.priority === undefined ? 100 : r.priority,
      r.media_ids ? JSON.stringify(r.media_ids) : null, r.once_per_person ? 1 : 0, ts, ts,
    ).lastInsertRowid);
  };

  /* ---------------- webhook envelopes ---------------- */
  console.log('\nwebhook envelopes');

  // 1. A plain DM, the shape Instagram actually sends.
  const dmBody = {
    object: 'instagram',
    entry: [{ id: IG_USER, time: t, messaging: [{ sender: { id: FAN }, recipient: { id: IG_USER }, timestamp: t, message: { mid: 'mid.1', text: 'link please' } }] }],
  };
  let evs = parseWebhookBody(tid, dmBody);
  eq('a DM parses', evs.map((e) => [e.kind, e.text, e.senderId]), [['dm', 'link please', FAN]]);

  // 2. A story reply — same envelope, but the message carries reply_to.story.
  const storyBody = {
    object: 'instagram',
    entry: [{ id: IG_USER, time: t, messaging: [{ sender: { id: FAN }, recipient: { id: IG_USER }, timestamp: t, message: { mid: 'mid.2', text: '🔥', reply_to: { story: { id: 'story_1', url: 'https://…' } } } }] }],
  };
  evs = parseWebhookBody(tid, storyBody);
  eq('a story reply parses as story_reply', evs.map((e) => e.kind), ['story_reply']);

  // 3. The shape Meta's App Dashboard "Test" button sends: a change on the `messages` field. This is the one that
  //    used to vanish silently, which is why pressing Test looked like the product was broken.
  const testButtonBody = {
    object: 'instagram',
    entry: [{
      id: IG_USER,
      time: t,
      changes: [{ field: 'messages', value: { sender: { id: FAN }, recipient: { id: IG_USER }, timestamp: t, message: { mid: 'mid.3', text: 'PRICE' } } }],
    }],
  };
  evs = parseWebhookBody(tid, testButtonBody);
  eq("Meta's Test-button envelope parses", evs.map((e) => [e.kind, e.text, e.senderId]), [['dm', 'PRICE', FAN]]);

  // 4. …and a story reply inside that same envelope.
  evs = parseWebhookBody(tid, {
    object: 'instagram',
    entry: [{ id: IG_USER, changes: [{ field: 'messages', value: { sender: { id: FAN }, recipient: { id: IG_USER }, message: { mid: 'mid.4', text: 'yes', reply_to: { story: { id: 's2' } } } } }] }],
  });
  eq('a story reply in the Test envelope parses', evs.map((e) => e.kind), ['story_reply']);

  // 5. A comment.
  evs = parseWebhookBody(tid, {
    object: 'instagram',
    entry: [{ id: IG_USER, changes: [{ field: 'comments', value: { id: 'c_1', text: 'GUIDE', from: { id: FAN, username: 'fan' }, media: { id: 'media_A' } } }] }],
  });
  eq('a comment parses with its post id', evs.map((e) => [e.kind, e.text, e.mediaId, e.senderUsername]), [['comment', 'GUIDE', 'media_A', 'fan']]);

  // 6. Things that must NOT become events.
  check('our own echo is ignored', parseWebhookBody(tid, {
    object: 'instagram',
    entry: [{ id: IG_USER, messaging: [{ sender: { id: IG_USER }, recipient: { id: FAN }, message: { mid: 'mid.9', text: 'Sent!', is_echo: true } }] }],
  }).length === 0);
  check('our own comment is ignored', parseWebhookBody(tid, {
    object: 'instagram',
    entry: [{ id: IG_USER, changes: [{ field: 'comments', value: { id: 'c_2', text: 'thanks!', from: { id: IG_USER }, media: { id: 'media_A' } } }] }],
  }).length === 0);
  check('a redelivered message is ignored', parseWebhookBody(tid, dmBody).length === 0);
  check('a non-instagram object is ignored', parseWebhookBody(tid, { object: 'page', entry: [{ id: IG_USER, messaging: [{ sender: { id: FAN }, message: { mid: 'x', text: 'hi' } }] }] }).length === 0);
  check('an unhandled field is ignored', parseWebhookBody(tid, {
    object: 'instagram', entry: [{ id: IG_USER, changes: [{ field: 'message_reactions', value: { sender: { id: FAN }, reaction: 'love' } }] }],
  }).length === 0);

  /* ---------------- routing + signature ---------------- */
  console.log('\nrouting and signature');
  eq('the payload routes to this tenant', tenantsForWebhook(dmBody), [tid]);
  eq('the Test envelope routes too', tenantsForWebhook(testButtonBody), [tid]);
  eq('an unknown account falls back to the owner tenant', tenantsForWebhook({ entry: [{ id: '17841499999999999' }] }), [1]);

  const raw = JSON.stringify(dmBody);
  const good = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  check('a correctly signed body verifies', verifySignature(tid, raw, good));
  check('a tampered body does not', !verifySignature(tid, raw + ' ', good));
  check('a wrong secret does not', !verifySignature(tid, raw, 'sha256=' + crypto.createHmac('sha256', 'nope').update(raw).digest('hex')));
  check('a missing signature does not', !verifySignature(tid, raw, undefined));

  /* ---------------- matching ---------------- */
  console.log('\nmatching');
  const story = addRule({ name: 'Story replies', trigger_type: 'story_reply', priority: 10 });
  const kw = addRule({ name: 'Price keyword', trigger_type: 'dm_keyword', keywords: ['price', 'cost'], priority: 20 });
  const guide = addRule({ name: 'Guide comments', trigger_type: 'comment_keyword', keywords: ['guide'], media_ids: ['media_A'], priority: 30 });
  const off = addRule({ name: 'Disabled one', trigger_type: 'dm_any', enabled: 0, priority: 40 });

  const ev = (over: Record<string, unknown> = {}) => ({ kind: 'dm', text: '', senderId: FAN, ...over } as any);

  check('a keyword-less story rule answers every story reply', matches({ trigger_type: 'story_reply', keywords: '[]' } as any, 'anything'));
  check('a keyword-less DM rule answers nothing', !matches({ trigger_type: 'dm_keyword', keywords: '[]' } as any, 'anything'));
  check('keywords are case-insensitive', matches({ trigger_type: 'dm_keyword', keywords: '["price"]', match_mode: 'contains' } as any, 'What is the PRICE?'));
  check('story replies also reach DM rules', triggerApplies('story_reply', 'dm_keyword'));
  check('DM rules do not see comments', !triggerApplies('comment', 'dm_keyword'));
  eq('a rule with no post filter runs everywhere', ruleMediaIds({ media_ids: null }), []);

  let r = evaluateRules(tid, ev({ kind: 'story_reply', text: '🔥' }));
  eq('the story rule wins a story reply', r.matched?.id, story);
  r = evaluateRules(tid, ev({ text: 'how much is the price?' }));
  eq('the keyword rule wins a DM', r.matched?.id, kw);
  r = evaluateRules(tid, ev({ kind: 'comment', text: 'GUIDE please', mediaId: 'media_A', commentId: 'c_1' }));
  eq('the comment rule wins on the selected post', r.matched?.id, guide);

  /* ---------------- why a rule did not fire ---------------- */
  console.log('\nreasons a rule did not fire');
  r = evaluateRules(tid, ev({ kind: 'comment', text: 'GUIDE please', mediaId: 'media_B', commentId: 'c_2' }));
  check('a comment on another post does not match', r.matched === null, r.matched?.name);
  check('and the reason names the post filter', r.skipped.some((s) => s.ruleId === guide && /another post/.test(s.reason)), r.skipped);
  check('the disabled rule says it is turned off', r.skipped.some((s) => s.ruleId === off && /turned off/.test(s.reason)), r.skipped);
  check('the DM rules say they listen for something else', r.skipped.some((s) => s.ruleId === kw && /listens for/.test(s.reason)), r.skipped);

  r = evaluateRules(tid, ev({ text: 'hello there' }));
  check('a DM with no keyword match is explained', r.matched === null && r.skipped.some((s) => s.ruleId === kw && /price, cost/.test(s.reason)), r.skipped);

  // cooldown + once-per-person both read automation_contacts.last_rule_hits
  const ts = now();
  d.prepare('INSERT INTO automation_contacts (tenant_id, ig_id, username, message_count, first_seen, last_seen, last_rule_hits) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(tid, FAN, 'fan', 3, ts, ts, JSON.stringify({ [kw]: ts - 60 }));
  r = evaluateRules(tid, ev({ text: 'price?' }));
  check('a fresh hit is on cooldown', r.matched === null && r.skipped.some((s) => s.ruleId === kw && /Cooldown/.test(s.reason)), r.skipped);
  r = evaluateRules(tid, ev({ text: 'price?' }), { ignoreCooldown: true });
  eq('the simulator can ignore the cooldown', r.matched?.id, kw);

  d.prepare('UPDATE automation_rules SET once_per_person = 1 WHERE id = ?').run(kw);
  r = evaluateRules(tid, ev({ text: 'price?' }), { ignoreCooldown: true });
  check('once-per-person blocks a second reply', r.matched === null && r.skipped.some((s) => s.ruleId === kw && /once per person/.test(s.reason)), r.skipped);

  const first = addRule({ name: 'Welcome', trigger_type: 'dm_first', priority: 5 });
  r = evaluateRules(tid, ev({ text: 'hi' }));
  check('dm_first skips someone who has written before', r.skipped.some((s) => s.ruleId === first && /written to you before/.test(s.reason)), r.skipped);
  r = evaluateRules(tid, ev({ text: 'hi', senderId: 'brand-new-person' }));
  eq('dm_first fires for a new person', r.matched?.id, first);

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
