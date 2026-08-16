/* Thin fetch wrapper for the Resurfly API */
export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message); }
}

/** HTTP 402 + `{ code: 'quota' }` → global `rs:quota` event (the UpgradeModal listens); the error is still thrown to the caller. */
function maybeQuota(status: number, data: unknown) {
  if (status === 402 && data && typeof data === 'object' && (data as any).code === 'quota') {
    window.dispatchEvent(new CustomEvent('rs:quota', { detail: data }));
  }
}

async function req<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', ...init });
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    window.dispatchEvent(new CustomEvent('rs:unauthorized'));
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    maybeQuota(res.status, data);
    throw new ApiError(res.status, (data && (data as any).error) || (typeof data === 'string' && data) || `HTTP ${res.status}`, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => req<T>('GET', path),
  post: <T>(path: string, body?: unknown) => req<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => req<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => req<T>('PATCH', path, body),
  del: <T>(path: string) => req<T>('DELETE', path),
};

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

/** Server-sent events over POST (for Ask). */
export async function ssePost(path: string, body: unknown, handlers: { onEvent: (event: string, data: any) => void; signal?: AbortSignal }) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: handlers.signal, credentials: 'same-origin' });
  if (res.status === 401) window.dispatchEvent(new CustomEvent('rs:unauthorized'));
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '');
    let msg = t; let parsed: unknown = null;
    try { parsed = JSON.parse(t); msg = (parsed as any).error || t; } catch {}
    maybeQuota(res.status, parsed);
    throw new ApiError(res.status, msg || `HTTP ${res.status}`, parsed);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let ev = 'message'; let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try { handlers.onEvent(ev, JSON.parse(data)); } catch { handlers.onEvent(ev, data); }
    }
  }
}
