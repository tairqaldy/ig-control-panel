/**
 * Companion routes (round 5 spec §4).
 *  - `companionDevice` (mounted PUBLIC at /api/companion): POST /pair (code → token) and the bearer-token device API
 *    (GET /state, POST /harvest, POST|DELETE /session, DELETE /device). Its own middleware checks `Authorization: Bearer cmp_…`.
 *  - `companion` (mounted PROTECTED at /api/companion): POST /pair-code, GET /devices, DELETE /devices/:id,
 *    DELETE /devices/:id/session, GET /runs, GET|DELETE /notice.
 */
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { config } from '../config.js';
import { clientIp, tid } from '../auth.js';
import { quotaResponse } from '../services/plans.js';
import {
  authenticateDevice, clearDeviceSession, consumePairCode, createPairCode, deleteDevice, deviceJson, deviceState, getDevice, getNotice,
  harvestChunk, listDevices, listRuns, normalizePairCode, pairAllowed, pairDevice, runJson, serverHarvestEnabled, setDeviceSession, setNotice,
  type CompanionDeviceRow, type HarvestChunkInput,
} from '../services/companion.js';

declare module 'hono' {
  interface ContextVariableMap {
    companionDevice: CompanionDeviceRow;
  }
}

/* ------------------------------------------------------------------ */
/* Public: pairing + device API (bearer token)                          */
/* ------------------------------------------------------------------ */

export const companionDevice = new Hono();

const deviceAuth = createMiddleware(async (c, next) => {
  const dev = authenticateDevice(c.req.header('authorization'), c.req.header('user-agent'));
  if (!dev) return c.json({ error: 'Device token invalid or revoked. Pair the Companion again from Import.', code: 'unauthorized' }, 401);
  c.set('companionDevice', dev);
  await next();
});

/** POST /api/companion/pair { code, name?, ua? } → { token, tenantId, appUrl, device } */
companionDevice.post('/pair', async (c) => {
  if (!pairAllowed(clientIp(c))) return c.json({ error: 'Too many pairing attempts. Try again in a few minutes.', code: 'rate_limited' }, 429);
  const body = await c.req.json<{ code?: string; name?: string; ua?: string }>().catch(() => ({}) as { code?: string; name?: string; ua?: string });
  const code = normalizePairCode(String(body.code || ''));
  if (!code) return c.json({ error: 'That does not look like a pairing code (RSF-XXXX-XXXX).', code: 'bad_code' }, 400);
  const t = consumePairCode(code);
  if (t === null) return c.json({ error: 'Pairing code unknown or expired. Get a fresh one from Import → Companion.', code: 'bad_code' }, 400);
  const { token, device } = pairDevice(t, body.name, body.ua || c.req.header('user-agent'));
  const appUrl = config.publicUrl || new URL(c.req.url).origin;
  return c.json({ token, tenantId: t, appUrl, device: deviceJson(device) });
});

/** GET /api/companion/state */
companionDevice.get('/state', deviceAuth, (c) => c.json(deviceState(c.get('companionDevice'))));

/** POST /api/companion/harvest { items, done, cursor?, runId?, account? } */
companionDevice.post('/harvest', deviceAuth, async (c) => {
  const dev = c.get('companionDevice');
  const body = await c.req.json<HarvestChunkInput>().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'JSON body expected', code: 'bad_request' }, 400);
  const r = harvestChunk(dev.tenant_id, dev.id, 'companion', body);
  if (!r.ok) {
    if (r.code === 'quota') return quotaResponse(c, r.quota);
    return c.json({ error: r.error, code: r.code }, r.code === 'bad_run' ? 409 : 400);
  }
  return c.json(r.body);
});

/** POST /api/companion/session { sessionid, csrftoken, ds_user_id, ua, enabled, username? } — opt in / out of server-side harvesting. */
companionDevice.post('/session', deviceAuth, async (c) => {
  const dev = c.get('companionDevice');
  const body = await c.req.json<{ sessionid?: string; csrftoken?: string; ds_user_id?: string; ua?: string; username?: string; enabled?: boolean }>().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'JSON body expected', code: 'bad_request' }, 400);
  if (body.enabled === false) {
    clearDeviceSession(dev.id);
    return c.json({ ok: true, serverHarvest: { enabled: false, status: null, available: serverHarvestEnabled() } });
  }
  if (!serverHarvestEnabled()) return c.json({ error: 'Background harvesting is not enabled on this server (SERVER_HARVEST_ENABLED). Syncing from the browser keeps working.', code: 'not_available' }, 503);
  const sessionid = String(body.sessionid || '').trim();
  const csrftoken = String(body.csrftoken || '').trim();
  if (!sessionid || !csrftoken) return c.json({ error: 'sessionid and csrftoken are required (grant the cookies permission in the Companion).', code: 'bad_request' }, 400);
  if (sessionid.length > 400 || csrftoken.length > 200) return c.json({ error: 'session values look wrong', code: 'bad_request' }, 400);
  setDeviceSession(dev.id, {
    sessionid,
    csrftoken,
    ds_user_id: String(body.ds_user_id || '').slice(0, 40),
    ua: String(body.ua || c.req.header('user-agent') || '').slice(0, 300),
    username: body.username ? String(body.username).slice(0, 80) : undefined,
  });
  return c.json({ ok: true, serverHarvest: { enabled: true, status: null, available: true } });
});

/** DELETE /api/companion/session — wipe the stored session, turn server-side harvesting off. */
companionDevice.delete('/session', deviceAuth, (c) => {
  clearDeviceSession(c.get('companionDevice').id);
  return c.json({ ok: true, serverHarvest: { enabled: false, status: null, available: serverHarvestEnabled() } });
});

/** DELETE /api/companion/device — the extension removes its own pairing (token becomes invalid). */
companionDevice.delete('/device', deviceAuth, (c) => {
  const dev = c.get('companionDevice');
  deleteDevice(dev.tenant_id, dev.id);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Protected: dashboard side                                            */
/* ------------------------------------------------------------------ */

export const companion = new Hono();

/** POST /api/companion/pair-code → { code, expiresAt (epoch ms), ttlSeconds } */
companion.post('/pair-code', (c) => {
  const r = createPairCode(tid(c));
  return c.json({ ...r, ttlSeconds: Math.round((r.expiresAt - Date.now()) / 1000) });
});

/** GET /api/companion/devices → { devices, notice, serverHarvest: { available }, runs } */
companion.get('/devices', (c) => {
  const t = tid(c);
  return c.json({
    devices: listDevices(t).map(deviceJson),
    notice: getNotice(t),
    serverHarvest: { available: serverHarvestEnabled() },
    runs: listRuns(t, 10).map(runJson),
  });
});

/** DELETE /api/companion/devices/:id → revoke a device (its token and any stored session are gone). */
companion.delete('/devices/:id', (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400);
  const ok = deleteDevice(tid(c), id);
  return ok ? c.json({ ok: true }) : c.json({ error: 'device not found' }, 404);
});

/** DELETE /api/companion/devices/:id/session → turn off server-side harvesting for that device (keeps the pairing). */
companion.delete('/devices/:id/session', (c) => {
  const id = Number(c.req.param('id'));
  const dev = Number.isInteger(id) ? getDevice(id) : undefined;
  if (!dev || dev.tenant_id !== tid(c)) return c.json({ error: 'device not found' }, 404);
  clearDeviceSession(dev.id);
  return c.json({ ok: true, device: deviceJson(getDevice(dev.id)!) });
});

/** GET /api/companion/runs → { runs } (last 30, any source) */
companion.get('/runs', (c) => c.json({ runs: listRuns(tid(c), 30).map(runJson) }));

/** GET /api/companion/notice → { notice | null }; DELETE dismisses it. */
companion.get('/notice', (c) => c.json({ notice: getNotice(tid(c)) }));
companion.delete('/notice', (c) => { setNotice(tid(c), null); return c.json({ ok: true }); });
