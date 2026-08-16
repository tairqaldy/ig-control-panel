import crypto from 'node:crypto';
import { Hono } from 'hono';
import { db, getMeta, j, setMeta } from '../db.js';
import { itemsFromUrls, parseHarvestJson, parseInstagramExportZip, upsertItems } from '../services/importers.js';
import { worker } from '../services/worker.js';
import { hasOpenAI } from '../services/openai.js';
import { processItem } from '../services/pipeline.js';

export const importRoutes = new Hono();

/** After import: queue for processing (analysis needs OpenAI; media fetch always makes sense while URLs are fresh). */
function afterImport(allIds: string[], autoAnalyze: boolean) {
  if (!allIds.length) return { queued: 0 };
  // Only (re)process items that actually need work: not analyzed yet, or media still pending (e.g. refreshed URLs).
  const d = db();
  const need = d.prepare("SELECT id FROM items WHERE id = ? AND (analysis_status != 'done' OR media_status = 'pending')");
  const ids = allIds.filter((id) => !!need.get(id));
  if (!ids.length) return { queued: 0 };
  if (hasOpenAI() && autoAnalyze) return { queued: worker.enqueue(ids) };
  // No key: still fetch media promptly (URLs expire) — light background loop, sequential.
  (async () => {
    for (const id of ids) {
      try { await processItem(id, {}); } catch {}
    }
  })();
  return { queued: 0, mediaOnly: true };
}

/** Harvester JSON (multipart file field "file" or raw JSON body). */
importRoutes.post('/harvest', async (c) => {
  const ct = c.req.header('content-type') || '';
  let text = '';
  let filename: string | undefined;
  let autoAnalyze = true;
  if (ct.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const f = form.get('file');
    if (!f || typeof f === 'string') return c.json({ error: 'file missing' }, 400);
    filename = (f as File).name;
    text = await (f as File).text();
    autoAnalyze = form.get('auto_analyze') !== '0';
  } else {
    text = await c.req.text();
  }
  if (!text || text.length < 2) return c.json({ error: 'empty upload' }, 400);
  if (text.length > 400e6) return c.json({ error: 'file too large' }, 413);
  let parsed;
  try { parsed = parseHarvestJson(text); } catch (e: any) { return c.json({ error: e.message }, 400); }
  const res = upsertItems(parsed.items, 'harvest', filename);
  if (parsed.file.account?.username) db().prepare("INSERT INTO meta (key, value) VALUES ('ig_username', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(parsed.file.account.username);
  const q = afterImport(res.ids, autoAnalyze);
  return c.json({ ...res, ids: undefined, ...q, account: parsed.file.account || null });
});

/** Instagram "Download your information" ZIP (JSON format). */
importRoutes.post('/instagram-export', async (c) => {
  const form = await c.req.formData();
  const f = form.get('file');
  if (!f || typeof f === 'string') return c.json({ error: 'file missing' }, 400);
  const includeLiked = form.get('include_liked') === '1';
  const buf = Buffer.from(await (f as File).arrayBuffer());
  let parsed;
  try { parsed = parseInstagramExportZip(buf, { includeLiked }); } catch (e: any) { return c.json({ error: `Could not read zip: ${e.message}` }, 400); }
  if (!parsed.items.length) return c.json({ error: `No saved posts found in this export. ${parsed.notes.join('; ')}. Make sure you requested the export in JSON format.` }, 400);
  const res = upsertItems(parsed.items, 'export', (f as File).name);
  const q = afterImport(res.ids, form.get('auto_analyze') !== '0');
  return c.json({ ...res, ids: undefined, ...q, notes: parsed.notes });
});

/** Manual URLs */
importRoutes.post('/urls', async (c) => {
  const body = await c.req.json<{ urls: string[] | string; auto_analyze?: boolean }>();
  const raw = Array.isArray(body.urls) ? body.urls : String(body.urls || '').split(/\s+|,|;/);
  const items = itemsFromUrls(raw);
  if (!items.length) return c.json({ error: 'No Instagram URLs found' }, 400);
  const res = upsertItems(items, 'manual');
  const q = afterImport(res.ids, body.auto_analyze !== false);
  return c.json({ ...res, ids: undefined, ...q });
});

importRoutes.get('/history', (c) => {
  return c.json({ imports: db().prepare('SELECT * FROM imports ORDER BY id DESC LIMIT 50').all() });
});

/* ------------------------------------------------------------------ */
/* Direct upload from the harvester (cross-site form POST with a token) */
/* ------------------------------------------------------------------ */

/** Issue (or reuse) a 24h upload token. Auth required. */
importRoutes.post('/token', (c) => {
  const cur = j<{ token: string; exp: number } | null>(getMeta('upload_token'), null);
  if (cur && cur.exp > Date.now() + 60 * 60_000) return c.json({ token: cur.token, expiresAt: cur.exp });
  const token = crypto.randomBytes(24).toString('base64url');
  const exp = Date.now() + 24 * 3600_000;
  setMeta('upload_token', JSON.stringify({ token, exp }));
  return c.json({ token, expiresAt: exp });
});

export function validUploadToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const cur = j<{ token: string; exp: number } | null>(getMeta('upload_token'), null);
  if (!cur || cur.exp < Date.now()) return false;
  const a = Buffer.from(token), b = Buffer.from(cur.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Public endpoint (token-protected): the harvester posts its JSON here as a normal form submission. Responds with HTML. */
export const harvestFormRoute = new Hono();
harvestFormRoute.post('/', async (c) => {
  const html = (title: string, body: string, ok: boolean) => c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f1ea;color:#17161a;font-family:ui-sans-serif,system-ui,sans-serif">
<div style="max-width:520px;padding:32px;border:1px solid #e3dfd3;border-radius:16px;background:#fbfaf6;box-shadow:0 8px 24px -12px rgba(23,22,26,.18)">
<div style="font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#8b877d;margin-bottom:6px">Resurface</div>
<h1 style="font-family:Georgia,serif;font-weight:400;font-size:28px;margin:0 0 10px">${title}</h1>
<p style="font-size:14px;line-height:1.55;color:#4a4843;margin:0 0 18px">${body}</p>
${ok ? '<a href="/import" style="display:inline-block;background:#177a4c;color:#f4f1ea;text-decoration:none;padding:10px 16px;border-radius:12px;font-weight:600;font-size:14px">Open the dashboard →</a>' : ''}
</div></body>`, ok ? 200 : 401);
  const ct = c.req.header('content-type') || '';
  if (!ct.includes('multipart/form-data')) return html('Wrong request', 'Expected a multipart form.', false);
  const form = await c.req.formData();
  const token = String(form.get('token') || '');
  if (!validUploadToken(token)) return html('Upload token invalid or expired', 'Go to Import in your dashboard, copy the harvester script/bookmarklet again (it embeds a fresh 24h token), then re-run it on instagram.com.', false);
  const f = form.get('file');
  if (!f || typeof f === 'string') return html('No file', 'The upload contained no JSON file.', false);
  let parsed;
  try { parsed = parseHarvestJson(await (f as File).text()); } catch (e: any) { return html('Could not read the file', String(e.message || e), false); }
  const res = upsertItems(parsed.items, 'harvest', (f as File).name || 'harvester-direct.json');
  if (parsed.file.account?.username) setMeta('ig_username', parsed.file.account.username);
  const q = afterImport(res.ids, true);
  return html(`Imported ${res.total.toLocaleString()} saves`, `${res.created} new · ${res.updated} updated${q.queued ? ` · ${q.queued} queued for analysis` : ''}. Analysis runs in the background — you can close this tab.`, true);
});
