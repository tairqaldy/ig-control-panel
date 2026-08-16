import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '../../lib/api';
import type { IgAccountResponse } from '../../lib/types-instagram';

export const IG_ACCOUNT_KEY = ['ig-account'] as const;

/** GET /api/instagram/account — tolerant of an older server without the endpoint (404 → `{ unavailable: true }`). */
export async function fetchIgAccount(): Promise<IgAccountResponse> {
  try {
    const r = await api.get<IgAccountResponse | string>('/api/instagram/account');
    if (!r || typeof r !== 'object') return { connected: false, configured: false, account: null, source: null, unavailable: true }; // SPA html from an older server
    return { connected: !!r.connected, configured: !!r.configured, account: r.account ?? null, source: r.source ?? null };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 501)) return { connected: false, configured: false, account: null, source: null, unavailable: true };
    throw e;
  }
}

export function useIgAccount() {
  return useQuery({ queryKey: IG_ACCOUNT_KEY, queryFn: fetchIgAccount, staleTime: 30_000, retry: 1 });
}

/** Sends the browser to Meta's OAuth screen (the server 302s to instagram.com). */
export function startInstagramConnect() {
  window.location.assign('/api/instagram/connect');
}

export function useDisconnectInstagram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del('/api/instagram/account'),
    onSuccess: () => {
      toast.success('Instagram disconnected');
      qc.invalidateQueries({ queryKey: IG_ACCOUNT_KEY });
      qc.invalidateQueries({ queryKey: ['auto-status'] });
      qc.invalidateQueries({ queryKey: ['ig-analytics'] });
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e: any) => toast.error(e?.message || 'Could not disconnect'),
  });
}
