import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '../../lib/api';
import type { CompanionDevice, CompanionDevicesResponse, PairCode } from '../../lib/types-instagram';

export const COMPANION_DEVICES_KEY = ['companion-devices'] as const;

/** Chrome Web Store link (env `VITE_COMPANION_URL`), falling back to the docs page for "Load unpacked". */
export const COMPANION_INSTALL_URL: string = (import.meta.env.VITE_COMPANION_URL as string | undefined) || 'https://github.com/tairqaldy/resurfly/blob/main/docs/COMPANION.md';
export const COMPANION_IS_STORE = /chrome\.google\.com|chromewebstore\.google\.com/.test(COMPANION_INSTALL_URL);

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Server rows are snake_case (table columns); tolerate camelCase too. */
export function normalizeDevice(d: any): CompanionDevice {
  const status = d.sessionStatus ?? d.igSessionStatus ?? d.ig_session_status ?? null;
  return {
    id: Number(d.id),
    name: d.name ?? null,
    createdAt: num(d.createdAt ?? d.created_at),
    lastSeenAt: num(d.lastSeenAt ?? d.last_seen_at),
    lastHarvestAt: num(d.lastHarvestAt ?? d.last_harvest_at),
    lastHarvestCount: num(d.lastHarvestCount ?? d.last_harvest_count),
    ua: d.ua ?? null,
    serverHarvest: !!(d.serverHarvest ?? d.server_harvest),
    igSessionStatus: status === 'ok' || status === 'invalid' ? status : null,
    igSessionCheckedAt: num(d.sessionCheckedAt ?? d.igSessionCheckedAt ?? d.ig_session_checked_at),
  };
}

export async function fetchCompanionDevices(): Promise<CompanionDevicesResponse> {
  try {
    const r = await api.get<any>('/api/companion/devices');
    if (!r || typeof r !== 'object') return { devices: [], unavailable: true }; // SPA html from an older server
    const list: any[] = Array.isArray(r) ? r : Array.isArray(r?.devices) ? r.devices : [];
    return { devices: list.map(normalizeDevice), notice: r?.notice ?? null, serverHarvestEnabled: r?.serverHarvest?.available ?? r?.serverHarvestEnabled ?? r?.server_harvest_enabled ?? undefined };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 501)) return { devices: [], unavailable: true };
    throw e;
  }
}

export function useCompanionDevices(enabled = true) {
  return useQuery({ queryKey: COMPANION_DEVICES_KEY, queryFn: fetchCompanionDevices, enabled, staleTime: 15_000, refetchInterval: 30_000, retry: 1 });
}

export function usePairCode() {
  return useMutation({
    mutationFn: async () => {
      const r = await api.post<any>('/api/companion/pair-code');
      const expiresAt = num(r?.expiresAt ?? r?.expires_at) ?? Math.floor(Date.now() / 1000) + 300;
      return { code: String(r?.code || ''), expiresAt: expiresAt > 1e12 ? Math.floor(expiresAt / 1000) : expiresAt } as PairCode;
    },
    onError: (e: any) => toast.error(e?.status === 404 ? 'Companion pairing is not available on this server yet.' : e?.message || 'Could not create a pairing code'),
  });
}

export function useRevokeDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/companion/devices/${id}`),
    onSuccess: () => { toast.success('Device removed — it will stop syncing'); qc.invalidateQueries({ queryKey: COMPANION_DEVICES_KEY }); },
    onError: (e: any) => toast.error(e?.message || 'Could not remove the device'),
  });
}

/** Turn server-side harvesting off for one device (wipes its stored Instagram session, keeps the pairing): DELETE /api/companion/devices/:id/session. */
export function useDisableServerHarvest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: number) => api.del(`/api/companion/devices/${deviceId}/session`),
    onSuccess: () => { toast.success('Background harvesting turned off — the stored Instagram session was deleted'); qc.invalidateQueries({ queryKey: COMPANION_DEVICES_KEY }); },
    onError: (e: any) => toast.error(e?.status === 404 ? 'That device is gone already — refresh the list. (You can also flip the toggle off in the Companion popup.)' : e?.message || 'Could not turn it off'),
  });
}
