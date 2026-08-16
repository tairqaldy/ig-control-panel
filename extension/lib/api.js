/*
 * Resurfly Companion — device-token client for /api/companion/*.
 *
 * Contract (docs/dev/ROUND5-SPEC.md §4):
 *   POST   {app}/api/companion/pair      { code, name, ua }              → { token, tenantId, appUrl }
 *   GET    {app}/api/companion/state     (Bearer)                        → { knownIds, total, lastHarvestAt, harvestQuota, serverHarvest, minIntervalMinutes }
 *   POST   {app}/api/companion/harvest   (Bearer) { items, done, cursor?, runId? } → { runId, imported, newItems, leftOut, quota }
 *   POST   {app}/api/companion/session   (Bearer) { sessionid, csrftoken, ds_user_id, ua, enabled }
 *   DELETE {app}/api/companion/session   (Bearer)
 *
 * Errors surface as ApiError with a stable `code`:
 *   'unauthorized' (401 → the device was revoked / token invalid),
 *   'quota' (402 → daily harvest quota, body attached),
 *   'network' (fetch threw / 5xx after retries), 'http' (anything else).
 */

export class ApiError extends Error {
  constructor(message, { code = 'http', status = 0, body = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

export function normalizeAppUrl(url) {
  let s = String(url || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    // keep only the origin — the app is always mounted at the root
    return u.origin;
  } catch (e) {
    return '';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, init, { retries = 3, retryOn5xx = true } = {}) {
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (attempt >= retries) throw new ApiError(`Could not reach ${new URL(url).host} (${e && e.message ? e.message : e})`, { code: 'network' });
      await sleep(1000 * Math.pow(2, attempt++));
      continue;
    }
    if ((res.status === 429 || (retryOn5xx && res.status >= 500)) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after')) * 1000;
      await sleep(ra > 0 ? Math.min(ra, 30000) : 1500 * Math.pow(2, attempt));
      attempt++;
      continue;
    }
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
    if (res.ok) return body;
    const msg = (body && (body.error || body.message)) || `HTTP ${res.status}`;
    if (res.status === 401) throw new ApiError(msg, { code: 'unauthorized', status: 401, body });
    if (res.status === 402) throw new ApiError(msg, { code: 'quota', status: 402, body });
    if (res.status >= 500) throw new ApiError(msg, { code: 'network', status: res.status, body });
    throw new ApiError(msg, { code: 'http', status: res.status, body });
  }
}

/** Public: exchange a pairing code for a device token. */
export async function pair(appUrl, { code, name, ua }) {
  const base = normalizeAppUrl(appUrl);
  if (!base) throw new ApiError('Enter your Resurfly URL first.', { code: 'http' });
  return request(`${base}/api/companion/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: String(code || '').trim().toUpperCase(), name, ua }),
  }, { retries: 1 });
}

/** Authenticated client bound to one app + device token. */
export function createClient({ appUrl, token }) {
  const base = normalizeAppUrl(appUrl);
  const auth = { authorization: `Bearer ${token}` };
  const json = (body) => ({ ...auth, 'content-type': 'application/json' });
  return {
    base,
    /** GET /api/companion/state */
    state: () => request(`${base}/api/companion/state`, { method: 'GET', headers: auth }),
    /** POST /api/companion/harvest — one chunk. `items` ≤ 100. */
    harvest: ({ items, done, cursor, runId }) => request(`${base}/api/companion/harvest`, {
      method: 'POST',
      headers: json(),
      body: JSON.stringify({ items, done: !!done, cursor: cursor || undefined, runId: runId || undefined }),
    }, { retries: 3, retryOn5xx: true }),
    /** POST /api/companion/session — opt in to server-side harvesting. */
    setSession: ({ sessionid, csrftoken, ds_user_id, ua, enabled }) => request(`${base}/api/companion/session`, {
      method: 'POST',
      headers: json(),
      body: JSON.stringify({ sessionid, csrftoken, ds_user_id, ua, enabled: enabled !== false }),
    }, { retries: 1 }),
    /** DELETE /api/companion/session — revoke server-side harvesting. */
    clearSession: () => request(`${base}/api/companion/session`, { method: 'DELETE', headers: auth }, { retries: 1 }),
    /** DELETE /api/companion/device — remove this device (and its session) server-side; the token stops working. */
    deleteDevice: () => request(`${base}/api/companion/device`, { method: 'DELETE', headers: auth }, { retries: 1 }),
  };
}
