import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { useQuota } from '../../lib/store';

export interface ImportResult { total: number; created: number; updated: number; queued?: number; leftOut?: number; quota?: unknown }

/**
 * The three upload mutations (harvester JSON, Instagram export ZIP, pasted URLs) with the shared success handling:
 * toast, plan leftovers → Upgrade toast, and cache invalidation. Used by ScriptSteps + AdvancedImport (and Welcome via re-export).
 */
export function useImports(opts: { autoAnalyze: boolean; includeLiked?: boolean; onDone?: (r: ImportResult) => void }) {
  const qc = useQueryClient();
  const { openUpgrade, refreshPlan } = useQuota();
  const done = (r: ImportResult) => {
    toast.success(`Imported ${r.total}: ${r.created} new, ${r.updated} updated${r.queued ? ` · ${r.queued} queued for analysis` : ''}`);
    // Hosted: the server queues only what fits the plan allowance and reports the rest as leftOut.
    if ((r.leftOut ?? 0) > 0) toast(`${Number(r.leftOut).toLocaleString()} saves are waiting for a bigger plan`, { action: { label: 'Upgrade', onClick: () => openUpgrade({ reason: `Analyze the ${Number(r.leftOut).toLocaleString()} saves that didn't fit your allowance` }) }, duration: 8000 });
    for (const k of ['items', 'stats', 'jobs-status', 'imports', 'facets', 'onboarding']) qc.invalidateQueries({ queryKey: [k] });
    void refreshPlan();
    opts.onDone?.(r);
  };
  const onError = (e: any) => { if (e?.status !== 402) toast.error(e?.message || 'Import failed'); };
  const harvest = useMutation({ mutationFn: (f: File) => { const fd = new FormData(); fd.append('file', f); fd.append('auto_analyze', opts.autoAnalyze ? '1' : '0'); return api.post<ImportResult>('/api/import/harvest', fd); }, onSuccess: done, onError });
  const exportZip = useMutation({ mutationFn: (f: File) => { const fd = new FormData(); fd.append('file', f); fd.append('auto_analyze', opts.autoAnalyze ? '1' : '0'); fd.append('include_liked', opts.includeLiked ? '1' : '0'); return api.post<ImportResult>('/api/import/instagram-export', fd); }, onSuccess: done, onError });
  const urls = useMutation({ mutationFn: (text: string) => api.post<ImportResult>('/api/import/urls', { urls: text, auto_analyze: opts.autoAnalyze }), onSuccess: done, onError });
  return { harvest, exportZip, urls };
}
