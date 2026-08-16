import { Hono } from 'hono';
import { db } from '../db.js';
import { itemsFromUrls, parseHarvestJson, parseInstagramExportZip, upsertItems } from '../services/importers.js';
import { worker } from '../services/worker.js';
import { hasOpenAI } from '../services/openai.js';
import { processItem } from '../services/pipeline.js';

export const importRoutes = new Hono();

/** After import: queue for processing (analysis needs OpenAI; media fetch always makes sense while URLs are fresh). */
function afterImport(ids: string[], autoAnalyze: boolean) {
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
