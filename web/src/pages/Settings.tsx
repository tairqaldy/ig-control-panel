import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Save, FlaskConical, Database, Cpu, KeyRound, Bot, RefreshCw, HardDrive, ExternalLink } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, Field } from '../components/ui';
import { fmtBytes } from '../lib/utils';
import { useAuth } from '../lib/store';

export default function Settings() {
  const qc = useQueryClient();
  const auth = useAuth();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<any>('/api/settings') });
  const [f, setF] = useState<Record<string, string>>({});
  const [conc, setConc] = useState<number>(3);
  useEffect(() => { if (q.data) { setF(q.data.values); setConc(q.data.effective.concurrency); } }, [q.data]);
  const save = useMutation({ mutationFn: () => api.put('/api/settings', { ...f, concurrency: conc }), onSuccess: () => { toast.success('Settings saved'); qc.invalidateQueries({ queryKey: ['settings'] }); qc.invalidateQueries({ queryKey: ['auth'] }); qc.invalidateQueries({ queryKey: ['jobs-status'] }); auth.refresh(); } });
  const testAI = useMutation({ mutationFn: () => api.post<any>('/api/settings/test-openai'), onSuccess: (r) => (r.ok ? toast.success(r.message) : toast.error(r.message)) });
  const testMeta = useMutation({ mutationFn: () => api.post<any>('/api/settings/test-meta'), onSuccess: (r) => (r.ok ? toast.success(`Meta OK: @${r.me?.username || r.me?.user_id}`) : toast.error(r.message)) });
  const reindex = useMutation({ mutationFn: () => api.post<any>('/api/jobs/reindex'), onSuccess: (r) => toast.success(`Reindexed ${r.indexed} items, ${r.neighbors} neighbor sets`) });
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const e = q.data?.effective;
  const locked = (k: string) => !!e?.envLocked?.[k];

  return (
    <div className="max-w-3xl">
      <PageHeader eyebrow="Settings" title="Configuration" subtitle="Values set as environment variables on the server take precedence and are shown locked. Everything else is stored in the app database." actions={<button onClick={() => save.mutate()} disabled={save.isPending} className="btn btn-primary"><Save size={14} /> Save</button>} />

      <section className="card p-6 mb-4">
        <div className="flex items-center gap-2 mb-4"><KeyRound size={16} className="text-accent" /><h2 className="text-[15px] font-semibold">OpenAI</h2><span className="ml-auto text-[12px] text-muted">{e?.openai}</span></div>
        <div className="grid gap-4">
          <Field label="API key" hint={locked('openai_api_key') ? 'Set via OPENAI_API_KEY env var.' : 'Stored in the database on your volume. Leave blank to remove.'}>
            <input value={f.openai_api_key || ''} onChange={(ev) => set('openai_api_key', ev.target.value)} disabled={locked('openai_api_key')} className="input font-mono" placeholder="sk-…" />
          </Field>
          <div className="grid sm:grid-cols-3 gap-4">
            <Field label="Analysis model" hint="Vision-capable. Default gpt-5.4-mini."><input value={f.analysis_model || ''} onChange={(ev) => set('analysis_model', ev.target.value)} disabled={locked('analysis_model')} className="input font-mono" placeholder={e?.models?.analysis} /></Field>
            <Field label="Ask model"><input value={f.ask_model || ''} onChange={(ev) => set('ask_model', ev.target.value)} disabled={locked('ask_model')} className="input font-mono" placeholder={e?.models?.ask} /></Field>
            <Field label="Transcription model"><input value={f.transcribe_model || ''} onChange={(ev) => set('transcribe_model', ev.target.value)} disabled={locked('transcribe_model')} className="input font-mono" placeholder={e?.models?.transcribe} /></Field>
          </div>
          <div className="flex items-center gap-2"><button onClick={() => testAI.mutate()} className="btn btn-sm"><FlaskConical size={13} /> Test OpenAI</button><span className="text-[12px] text-muted">Embeddings: {e?.models?.embed} · {e?.embedDims} dims</span></div>
        </div>
      </section>

      <section className="card p-6 mb-4">
        <div className="flex items-center gap-2 mb-4"><Cpu size={16} className="text-accent" /><h2 className="text-[15px] font-semibold">Pipeline</h2></div>
        <Field label={`Concurrency: ${conc} item${conc > 1 ? 's' : ''} at a time`} hint="Higher = faster, but more likely to hit OpenAI rate limits on new accounts. 2–4 is a good range.">
          <input type="range" min={1} max={8} value={conc} onChange={(ev) => setConc(Number(ev.target.value))} className="w-full accent-[var(--accent)]" />
        </Field>
        <div className="mt-3 grid sm:grid-cols-2 gap-2 text-[12.5px] text-muted">
          <div>ffmpeg: <code className="font-mono text-ink">{e?.ffmpeg}</code></div>
          <div>keep videos: <code className="font-mono text-ink">{String(e?.keepVideos)}</code></div>
          <div>data dir: <code className="font-mono text-ink">{e?.dataDir}</code></div>
          <div>public URL: <code className="font-mono text-ink">{e?.publicUrl || '(auto)'}</code></div>
        </div>
        <div className="mt-4 flex items-center gap-2"><button onClick={() => reindex.mutate()} className="btn btn-sm"><RefreshCw size={13} className={reindex.isPending ? 'animate-spin' : ''} /> Rebuild search index & similarity</button><span className="text-[12px] text-muted">Safe to run anytime.</span></div>
      </section>

      <section id="automations" className="card p-6 mb-4">
        <div className="flex items-center gap-2 mb-1"><Bot size={16} className="text-accent" /><h2 className="text-[15px] font-semibold">Instagram automations (Meta)</h2><span className="ml-auto text-[12px] text-muted">{e?.meta?.configured ? 'configured' : 'not configured'}</span></div>
        <p className="text-[12.5px] text-muted mb-4">From your Meta app → Instagram → API setup with Instagram login. See <a className="text-accent underline" href="https://github.com/tairqaldy/resurface/blob/main/docs/AUTOMATIONS.md" target="_blank" rel="noreferrer">docs/AUTOMATIONS.md</a>. Webhook URL: <code className="font-mono">{e?.publicUrl || window.location.origin}/api/webhooks/instagram</code></p>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Instagram user ID" hint="From GET /me?fields=user_id — the numeric professional account id."><input value={f.ig_user_id || ''} onChange={(ev) => set('ig_user_id', ev.target.value)} disabled={e?.meta?.envLocked?.igUserId} className="input font-mono" placeholder="1784…" /></Field>
          <Field label="Verify token" hint="Any string you choose; paste the same in the Meta webhook config."><input value={f.meta_verify_token || ''} onChange={(ev) => set('meta_verify_token', ev.target.value)} disabled={e?.meta?.envLocked?.verifyToken} className="input font-mono" placeholder="undig-verify-…" /></Field>
          <Field label="Access token (long-lived)" hint="60-day token. Refresh before it expires."><input value={f.ig_access_token || ''} onChange={(ev) => set('ig_access_token', ev.target.value)} disabled={e?.meta?.envLocked?.accessToken} className="input font-mono" placeholder="IGAA…" /></Field>
          <Field label="App secret" hint="Used to verify webhook signatures. Recommended."><input value={f.meta_app_secret || ''} onChange={(ev) => set('meta_app_secret', ev.target.value)} disabled={e?.meta?.envLocked?.appSecret} className="input font-mono" placeholder="••••" /></Field>
        </div>
        <div className="mt-4 flex items-center gap-2"><button onClick={() => testMeta.mutate()} className="btn btn-sm"><FlaskConical size={13} /> Test Meta connection</button><a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm text-muted"><ExternalLink size={12} /> Meta for Developers</a></div>
      </section>

      <section className="card p-6">
        <div className="flex items-center gap-2 mb-3"><Database size={16} className="text-accent" /><h2 className="text-[15px] font-semibold">Storage</h2></div>
        <div className="grid sm:grid-cols-3 gap-3 text-[13px]">
          <div className="card-flat p-3"><div className="eyebrow mb-1"><HardDrive size={10} className="inline mr-1" />Media</div><div className="display text-[22px]">{q.data ? fmtBytes(q.data.storage.mediaBytes) : '—'}</div></div>
          <div className="card-flat p-3"><div className="eyebrow mb-1">Database</div><div className="display text-[22px]">{q.data ? fmtBytes(q.data.storage.dbBytes) : '—'}</div></div>
          <div className="card-flat p-3"><div className="eyebrow mb-1">Version</div><div className="display text-[22px]">v{q.data?.version}</div></div>
        </div>
        <div className="mt-3 text-[12px] text-muted">Thumbnails (~30 KB each) and video frames are kept; videos are discarded after transcription unless KEEP_VIDEOS=true. Back up the data directory to keep everything.</div>
      </section>
    </div>
  );
}
