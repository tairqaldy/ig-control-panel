import { Hono } from 'hono';
import { db, now } from '../db.js';
import { config } from '../config.js';
import {
  automationsConfigured, contacts, findRule, getMe, handleIncoming, listRules, logSystemEvent, matches, metaConfig, parseWebhookBody, recentEvents, sendDm, verifySignature,
} from '../services/automations.js';

export const automations = new Hono();

automations.get('/status', async (c) => {
  const m = metaConfig();
  const base = config.publicUrl || new URL(c.req.url).origin;
  return c.json({
    configured: automationsConfigured(),
    webhookUrl: `${base}/api/webhooks/instagram`,
    verifyTokenSet: !!m.verifyToken,
    appSecretSet: !!m.appSecret,
    accessTokenSet: !!m.accessToken,
    igUserId: m.igUserId || null,
    apiVersion: m.apiVersion,
    rules: (db().prepare('SELECT COUNT(*) AS n FROM automation_rules').get() as any).n,
    events24h: (db().prepare('SELECT COUNT(*) AS n FROM automation_events WHERE ts > ?').get(now() - 86400) as any).n,
    contacts: (db().prepare('SELECT COUNT(*) AS n FROM automation_contacts').get() as any).n,
  });
});

automations.get('/rules', (c) => c.json({ rules: listRules() }));

automations.post('/rules', async (c) => {
  const b = await c.req.json<any>();
  const t = now();
  const info = db().prepare(`INSERT INTO automation_rules (name, enabled, trigger_type, match_mode, keywords, reply_text, reply_link, public_reply_text, cooldown_minutes, priority, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    String(b.name || 'Untitled rule').slice(0, 80), b.enabled === false ? 0 : 1, b.trigger_type || 'dm_keyword', b.match_mode || 'contains',
    JSON.stringify(Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(',').map((s: string) => s.trim()).filter(Boolean)),
    String(b.reply_text || ''), b.reply_link || null, b.public_reply_text || null, Number.isFinite(Number(b.cooldown_minutes)) ? Number(b.cooldown_minutes) : 1440, Number.isFinite(Number(b.priority)) ? Number(b.priority) : 100, t, t,
  );
  return c.json({ rule: db().prepare('SELECT * FROM automation_rules WHERE id = ?').get(info.lastInsertRowid) });
});

automations.put('/rules/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const b = await c.req.json<any>();
  const cur = db().prepare('SELECT * FROM automation_rules WHERE id = ?').get(id) as any;
  if (!cur) return c.json({ error: 'not found' }, 404);
  db().prepare(`UPDATE automation_rules SET name = ?, enabled = ?, trigger_type = ?, match_mode = ?, keywords = ?, reply_text = ?, reply_link = ?, public_reply_text = ?, cooldown_minutes = ?, priority = ?, updated_at = ? WHERE id = ?`).run(
    String(b.name ?? cur.name).slice(0, 80), b.enabled === undefined ? cur.enabled : b.enabled ? 1 : 0, b.trigger_type ?? cur.trigger_type, b.match_mode ?? cur.match_mode,
    b.keywords === undefined ? cur.keywords : JSON.stringify(Array.isArray(b.keywords) ? b.keywords : String(b.keywords).split(',').map((s: string) => s.trim()).filter(Boolean)),
    b.reply_text ?? cur.reply_text, b.reply_link === undefined ? cur.reply_link : b.reply_link || null, b.public_reply_text === undefined ? cur.public_reply_text : b.public_reply_text || null,
    b.cooldown_minutes ?? cur.cooldown_minutes, b.priority ?? cur.priority, now(), id,
  );
  return c.json({ rule: db().prepare('SELECT * FROM automation_rules WHERE id = ?').get(id) });
});

automations.delete('/rules/:id', (c) => {
  db().prepare('DELETE FROM automation_rules WHERE id = ?').run(Number(c.req.param('id')));
  return c.json({ ok: true });
});

automations.get('/events', (c) => c.json({ events: recentEvents(Math.min(500, Number(c.req.query('limit') || 100))) }));
automations.get('/contacts', (c) => c.json({ contacts: contacts() }));

/** Dry-run the rules engine against a fake message/comment. */
automations.post('/test', async (c) => {
  const b = await c.req.json<{ kind: 'dm' | 'comment' | 'story_reply'; text: string }>();
  const ev = { kind: b.kind || 'dm', text: b.text || '', senderId: 'test-user', senderUsername: 'test_user' } as const;
  const rule = findRule(ev, { ignoreCooldown: true });
  const all = listRules().map((r) => ({ id: r.id, name: r.name, enabled: !!r.enabled, trigger_type: r.trigger_type, matches: matches(r, ev.text) }));
  return c.json({ matched: rule, candidates: all });
});

/** Send a real test DM (to an IG-scoped user id that has messaged you before). */
automations.post('/send-test', async (c) => {
  const b = await c.req.json<{ recipient_id: string; text: string }>();
  try {
    const r = await sendDm(String(b.recipient_id), String(b.text || 'Test message from Resurface'));
    logSystemEvent(`Manual test DM sent to ${b.recipient_id}`, r);
    return c.json({ ok: true, result: r });
  } catch (e: any) {
    return c.json({ ok: false, message: String(e?.message || e) });
  }
});

automations.post('/whoami', async (c) => {
  try { return c.json({ ok: true, me: await getMe() }); } catch (e: any) { return c.json({ ok: false, message: String(e?.message || e) }); }
});

/* ---------------- Meta webhook (public; no session auth) ---------------- */
export const webhooks = new Hono();

webhooks.get('/instagram', (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');
  const expected = metaConfig().verifyToken;
  if (mode === 'subscribe' && expected && token === expected && challenge) {
    logSystemEvent('Webhook verified by Meta');
    return c.text(challenge, 200);
  }
  return c.text('Forbidden', 403);
});

webhooks.post('/instagram', async (c) => {
  const raw = await c.req.text();
  if (!verifySignature(raw, c.req.header('x-hub-signature-256'))) {
    const why = metaConfig().appSecret ? 'bad signature' : 'unsigned webhook while an access token is configured — set META_APP_SECRET (Meta app → Settings → Basic → App Secret)';
    logSystemEvent(`Webhook rejected: ${why}`, null, 'error');
    return c.text('Bad signature', 401);
  }
  let body: any = null;
  try { body = JSON.parse(raw); } catch { return c.text('Bad JSON', 400); }
  const events = parseWebhookBody(body);
  if (!events.length) logSystemEvent('Webhook received (no actionable events)', body);
  // Respond fast; process async.
  (async () => {
    for (const ev of events) {
      try { await handleIncoming(ev); } catch (e: any) { logSystemEvent(`Webhook processing error: ${e?.message || e}`, ev, 'error'); }
    }
  })();
  return c.text('EVENT_RECEIVED', 200);
});
