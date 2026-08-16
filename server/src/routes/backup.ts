/** Owner-only backup controls: status + run now. Mounted at /api/admin (protected). */
import { Hono } from 'hono';
import { currentTenant } from '../auth.js';
import { backupStatus, listBackups, runBackup } from '../services/backup.js';

export const admin = new Hono();

admin.use('*', async (c, next) => {
  const s = currentTenant(c);
  if (!s?.isOwner) return c.json({ error: 'Owner only.' }, 403);
  await next();
});

admin.get('/backup', async (c) => {
  const status = backupStatus();
  let objects: Array<{ key: string; size: number; lastModified: string }> = [];
  if (status.configured) { try { objects = await listBackups(); } catch (e) { return c.json({ ...status, objects, listError: (e as Error).message }); } }
  return c.json({ ...status, objects });
});

admin.post('/backup', async (c) => {
  try { const r = await runBackup('manual'); return c.json({ ok: true, ...r }); }
  catch (e) { return c.json({ ok: false, error: (e as Error).message }, 500); }
});
