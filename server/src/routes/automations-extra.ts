/**
 * Round-6 automations endpoints (spec §1), mounted with one line in ./extra.ts:
 *   GET  /api/automations/diagnostics      — the seven health checks
 *   POST /api/automations/simulate         — dry run of the real matcher, no Instagram call
 *   POST /api/automations/resubscribe      — re-run the webhook subscription, return Meta's raw answer
 *   POST /api/automations/rules/:id/test-send — a real DM for one rule; Meta's error comes back verbatim
 *   GET  /api/instagram/media              — the tenant's own posts for the rule builder's post picker
 *
 * The existing rules CRUD, /status, /events and /send-test stay in ./automations.ts.
 */
import { Hono } from 'hono';
import { db, getMeta, now, setMeta } from '../db.js';
import { tid } from '../auth.js';
import {
  composeReply, evaluateRules, getUsername, logAutomationEvent, logSystemEvent, metaErrorMessage, noteRuleError, sendDm,
  type IncomingEvent, type Rule,
} from '../services/automations.js';
import { runDiagnostics, readSubscription, SUBSCRIBED_FIELDS } from '../services/automations-diag.js';
import { igCredentials, igGet, subscribeWebhooks } from '../services/instagram.js';
import { chargeMetered, checkQuota, quotaResponse } from '../services/plans.js';

export const automationsExtra = new Hono();

/* ------------------------------------------------------------------ */
/* Diagnostics                                                          */
/* ------------------------------------------------------------------ */
automationsExtra.get('/diagnostics', async (c) => c.json(await runDiagnostics(tid(c))));

/* ------------------------------------------------------------------ */
/* Simulate — the real matcher against a made-up event                  */
/* ------------------------------------------------------------------ */
interface SimulateBody { kind?: 'dm' | 'comment' | 'story_reply'; text?: string; mediaId?: string; senderUsername?: string }

automationsExtra.post('/simulate', async (c) => {
  const t = tid(c);
  const b = await c.req.json<SimulateBody>().catch(() => ({} as SimulateBody));
  const kind: IncomingEvent['kind'] = b.kind === 'comment' || b.kind === 'story_reply' ? b.kind : 'dm';
  const ev: IncomingEvent = {
    kind,
    text: String(b.text || ''),
    // No real sender: a simulation must never be blocked by a cooldown or by "already replied to this person".
    senderId: '',
    senderUsername: (b.senderUsername || 'someone').replace(/^@/, ''),
    mediaId: b.mediaId ? String(b.mediaId) : undefined,
    commentId: kind === 'comment' ? 'simulated-comment' : undefined,
  };
  const { matched, skipped } = evaluateRules(t, ev, { ignoreCooldown: true });
  const wouldSend: { dm?: string; publicReply?: string } = {};
  if (matched) {
    const dm = composeReply(matched, ev);
    if (dm) wouldSend.dm = dm;
    if (kind === 'comment' && matched.public_reply_text) wouldSend.publicReply = matched.public_reply_text;
  }
  return c.json({
    matched: matched ? { ruleId: matched.id, name: matched.name } : null,
    wouldSend,
    skipped,
  });
});

/* ------------------------------------------------------------------ */
/* Resubscribe the webhook                                              */
/* ------------------------------------------------------------------ */
automationsExtra.post('/resubscribe', async (c) => {
  const t = tid(c);
  if (!igCredentials(t)) return c.json({ ok: false, error: 'Instagram is not connected.', code: 'not_connected' }, 400);
  const r = await subscribeWebhooks(t);
  const after = await readSubscription(t);
  logSystemEvent(t, r.ok ? `Webhook subscription renewed (${SUBSCRIBED_FIELDS.join(', ')})` : `Webhook subscription failed: ${r.error}`, after.response, r.ok ? 'ok' : 'error');
  return c.json({ ok: r.ok, error: r.error, fields: SUBSCRIBED_FIELDS, response: after.response, readError: after.error });
});

/* ------------------------------------------------------------------ */
/* Test-send one rule for real                                          */
/* ------------------------------------------------------------------ */
automationsExtra.post('/rules/:id/test-send', async (c) => {
  const t = tid(c);
  const id = Number(c.req.param('id'));
  const rule = db().prepare('SELECT * FROM automation_rules WHERE id = ? AND tenant_id = ?').get(id, t) as Rule | undefined;
  if (!rule) return c.json({ ok: false, error: 'That rule no longer exists.' }, 404);
  const b = await c.req.json<{ recipient?: string }>().catch(() => ({} as { recipient?: string }));
  const recipient = String(b.recipient || '').trim();
  if (!recipient) return c.json({ ok: false, error: 'Add the Instagram-scoped id of someone who has messaged you, and we will send them this rule\'s reply.' }, 400);
  const q = checkQuota(t, 'sends', 1);
  if (!q.ok) return quotaResponse(c, q);

  const username = await getUsername(t, recipient);
  const ev: IncomingEvent = { kind: rule.trigger_type.startsWith('comment') ? 'comment' : 'dm', text: '', senderId: recipient, senderUsername: username || undefined };
  const text = composeReply(rule, ev) || 'Test message from Resurfly';
  try {
    const result = await sendDm(t, recipient, text);
    chargeMetered(t, 'sends', 1, `rule:${id}:test-send`); // plan allowance first, then credits
    db().prepare('UPDATE automation_rules SET last_error = NULL, last_error_at = NULL WHERE id = ? AND tenant_id = ?').run(id, t);
    logAutomationEvent(t, { type: 'dm_out', direction: 'out', senderId: recipient, senderUsername: username, text, ruleId: id, status: 'ok', payload: { test: true, result } });
    return c.json({ ok: true, rule: { id, name: rule.name }, recipient, text, result });
  } catch (e) {
    const error = metaErrorMessage(e); // Instagram's own words
    noteRuleError(t, id, error);
    logAutomationEvent(t, { type: 'error', direction: 'out', senderId: recipient, senderUsername: username, text, ruleId: id, status: 'error', error, payload: { test: true } });
    return c.json({ ok: false, rule: { id, name: rule.name }, recipient, text, error, message: error });
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/instagram/media — the post picker                           */
/* ------------------------------------------------------------------ */
export const instagramMedia = new Hono();

const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count';
const MEDIA_TTL_S = 6 * 3600;
const MEDIA_PAGES = 2; // 2 × 50 = the newest 100 posts, plenty for a picker
const REFRESHED_KEY = 'ig_media_refreshed_at';
const inflight = new Set<number>();

function mediaRefreshedAt(t: number): number | null {
  const v = getMeta(t, REFRESHED_KEY);
  if (v && Number.isFinite(Number(v))) return Number(v);
  const r = db().prepare('SELECT MAX(fetched_at) AS ts FROM ig_media WHERE tenant_id = ?').get(t) as { ts: number | null } | undefined;
  return r?.ts ?? null;
}

/** Pull the newest posts from the Graph API into `ig_media` (round-5 table; insights columns are left alone). */
async function refreshMediaList(t: number): Promise<{ ok: boolean; error: string | null; count: number }> {
  const creds = igCredentials(t);
  if (!creds) return { ok: false, error: 'Instagram is not connected.', count: 0 };
  if (inflight.has(t)) return { ok: false, error: 'A refresh is already running.', count: 0 };
  inflight.add(t);
  try {
    const rows: any[] = [];
    let path: string | null = `${creds.igUserId}/media`;
    let absolute = false;
    for (let page = 0; page < MEDIA_PAGES && path; page++) {
      const r: { ok: boolean; error: string | null; data: { data?: any[]; paging?: { next?: string } } | null } =
        await igGet(path, absolute ? {} : { fields: MEDIA_FIELDS, limit: '50' }, creds.accessToken, absolute);
      if (!r.ok) return { ok: false, error: r.error, count: 0 };
      rows.push(...(r.data?.data || []));
      path = r.data?.paging?.next || null;
      absolute = true;
    }
    const d = db();
    const upsert = d.prepare(`INSERT INTO ig_media (tenant_id, id, caption, media_type, media_product_type, media_url, thumbnail_url, permalink, timestamp, like_count, comments_count, insights_json, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(tenant_id, id) DO UPDATE SET caption = excluded.caption, media_type = excluded.media_type, media_product_type = excluded.media_product_type, media_url = excluded.media_url,
        thumbnail_url = excluded.thumbnail_url, permalink = excluded.permalink, timestamp = excluded.timestamp, like_count = excluded.like_count, comments_count = excluded.comments_count, fetched_at = excluded.fetched_at`);
    const ts = now();
    d.transaction(() => {
      for (const m of rows) {
        if (!m?.id) continue;
        const taken = m.timestamp ? Math.floor(Date.parse(m.timestamp) / 1000) : null;
        upsert.run(t, String(m.id), m.caption ?? null, m.media_type ?? null, m.media_product_type ?? null, m.media_url ?? null, m.thumbnail_url ?? null, m.permalink ?? null,
          Number.isFinite(taken as number) ? taken : null, Number.isFinite(Number(m.like_count)) ? Number(m.like_count) : null, Number.isFinite(Number(m.comments_count)) ? Number(m.comments_count) : null, ts);
      }
    })();
    setMeta(t, REFRESHED_KEY, String(ts));
    return { ok: true, error: null, count: rows.length };
  } catch (e: any) {
    return { ok: false, error: `Could not reach Instagram: ${e?.message || e}`, count: 0 };
  } finally {
    inflight.delete(t);
  }
}

instagramMedia.get('/media', async (c) => {
  const t = tid(c);
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') || 100)));
  const force = c.req.query('refresh') === '1';
  const connected = !!igCredentials(t);
  let refreshedAt = mediaRefreshedAt(t);
  let error: string | null = null;
  if (connected && (force || !refreshedAt || now() - refreshedAt > MEDIA_TTL_S)) {
    const r = await refreshMediaList(t);
    if (r.ok) refreshedAt = mediaRefreshedAt(t);
    else error = r.error; // an expired token must not empty the picker: fall back to what is cached
  }
  const rows = db().prepare('SELECT id, caption, media_type, media_product_type, media_url, thumbnail_url, permalink, timestamp, like_count, comments_count FROM ig_media WHERE tenant_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?').all(t, limit) as any[];
  return c.json({
    media: rows.map((r) => ({
      id: String(r.id),
      caption: r.caption ? String(r.caption).slice(0, 140) : null,
      type: r.media_type || null,
      productType: r.media_product_type || null,
      thumb: r.thumbnail_url || r.media_url || null,
      permalink: r.permalink || null,
      timestamp: r.timestamp ?? null,
      likes: r.like_count ?? null,
      comments: r.comments_count ?? null,
    })),
    refreshedAt,
    connected,
    // `stale` = you are looking at cached posts because the live refresh did not work (usually an expired token).
    stale: !!error,
    error,
  });
});
