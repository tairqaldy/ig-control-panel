import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { Save, FlaskConical, Database, Cpu, KeyRound, RefreshCw, HardDrive, ExternalLink, ChevronDown, Download, Trash2, Laptop, Plug, ArrowRight, FileText } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, Field, Modal } from '../components/ui';
import { ConnectCard, InstagramGlyph } from '../components/instagram';
import { CompanionDevices } from '../components/import';
import { fmtBytes, cn } from '../lib/utils';
import { useAuth } from '../lib/store';

function Disclosure({ id, title, hint, open, onToggle, children }: { id?: string; title: string; hint?: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div id={id} className="rounded-xl border border-line bg-surface-2/40">
      <button type="button" onClick={onToggle} className="w-full flex items-center gap-2 px-4 py-3 text-left" aria-expanded={open}>
        <ChevronDown size={14} className={cn('text-muted transition-transform', open && 'rotate-180')} />
        <span className="text-[13.5px] font-medium">{title}</span>
        {hint && <span className="ml-auto text-[12px] text-muted">{hint}</span>}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="body" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="px-4 pb-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Settings() {
  const qc = useQueryClient();
  const auth = useAuth();
  const loc = useLocation();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<any>('/api/settings') });
  const [f, setF] = useState<Record<string, string>>({});
  const [conc, setConc] = useState<number>(3);
  const [metaOpen, setMetaOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  useEffect(() => { if (q.data) { setF(q.data.values); setConc(q.data.effective.concurrency); } }, [q.data]);
  // /settings#automations (old links) and /settings#integrations both land on the Instagram section; #automations also opens the Meta fields.
  useEffect(() => {
    const h = loc.hash.replace('#', '');
    if (h === 'automations' || h === 'meta') setMetaOpen(true);
    if (h) setTimeout(() => document.getElementById(h === 'automations' || h === 'meta' ? 'integrations' : h)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  }, [loc.hash]);
  const save = useMutation({ mutationFn: () => api.put('/api/settings', { ...f, concurrency: conc }), onSuccess: () => { toast.success('Settings saved'); qc.invalidateQueries({ queryKey: ['settings'] }); qc.invalidateQueries({ queryKey: ['auth'] }); qc.invalidateQueries({ queryKey: ['jobs-status'] }); qc.invalidateQueries({ queryKey: ['auto-status'] }); qc.invalidateQueries({ queryKey: ['ig-account'] }); auth.refresh(); } });
  const testAI = useMutation({ mutationFn: () => api.post<any>('/api/settings/test-openai'), onSuccess: (r) => (r.ok ? toast.success(r.message) : toast.error(r.message)) });
  const testMeta = useMutation({ mutationFn: () => api.post<any>('/api/settings/test-meta'), onSuccess: (r) => (r.ok ? toast.success(`Meta OK: @${r.me?.username || r.me?.user_id}`) : toast.error(r.message)) });
  const reindex = useMutation({ mutationFn: () => api.post<any>('/api/jobs/reindex'), onSuccess: (r) => toast.success(`Reindexed ${r.indexed} items, ${r.neighbors} neighbor sets`) });
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const e = q.data?.effective;
  const locked = (k: string) => !!e?.envLocked?.[k];
  const isOwner = e?.isOwner ?? !auth.hosted;
  const hostedTenant = auth.hosted && !isOwner;

  const doDelete = async () => {
    setDeleting(true);
    try { await api.del('/api/account'); toast.success('Account deleted.'); await auth.logout(); }
    catch (err: any) { toast.error(err?.message || 'Could not delete the account'); setDeleting(false); }
  };

  return (
    <div className="max-w-3xl">
      <PageHeader eyebrow="Settings" title={hostedTenant ? 'Integrations and data' : 'Integrations, engine and data'} subtitle={hostedTenant ? 'Instagram, paired devices and exports. Models and the OpenAI key are managed by the hosted service.' : 'Values set as server environment variables are shown locked; everything else is stored in the app database.'} actions={<button onClick={() => save.mutate()} disabled={save.isPending} className="btn btn-primary"><Save size={14} className={cn(save.isPending && 'animate-pulse')} /> Save changes</button>} />

      {/* ---------------- Integrations ---------------- */}
      <div id="integrations" className="eyebrow mb-2 scroll-mt-20">Integrations</div>
      <section className="card p-6 mb-4">
        <div className="flex items-center gap-2 mb-4"><InstagramGlyph size={16} className="text-accent" /><h2 className="text-[15px] font-semibold">Instagram</h2><span className="ml-auto text-[12px] text-muted">{e?.meta?.configured ? 'Credentials in place' : 'Not connected'}</span></div>
        <ConnectCard compact showSettingsLink={false} className="mb-3 !shadow-none border-line" />
        <Disclosure id="automations" title="Bring your own Meta app" hint={hostedTenant ? 'Advanced' : 'Self-host'} open={metaOpen} onToggle={() => setMetaOpen((o) => !o)}>
          <p className="text-[12.5px] text-muted mb-1 leading-relaxed">Paste the values from your Meta app → Instagram → API setup with Instagram login (<a className="text-accent underline" href="https://github.com/tairqaldy/resurfly/blob/main/docs/AUTOMATIONS.md" target="_blank" rel="noreferrer">guide</a>).</p>
          <p className="text-[12.5px] text-muted mb-4 leading-relaxed">Webhook URL: <code className="font-mono select-all">{e?.publicUrl || window.location.origin}/api/webhooks/instagram</code></p>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Instagram user ID" hint="From GET /me?fields=user_id — the numeric professional account id."><input value={f.ig_user_id || ''} onChange={(ev) => set('ig_user_id', ev.target.value)} disabled={e?.meta?.envLocked?.igUserId} className="input font-mono" placeholder="1784…" /></Field>
            <Field label="Verify token" hint="Any string you choose; paste the same in the Meta webhook config."><input value={f.meta_verify_token || ''} onChange={(ev) => set('meta_verify_token', ev.target.value)} disabled={e?.meta?.envLocked?.verifyToken} className="input font-mono" placeholder="resurfly-verify-…" /></Field>
            <Field label="Access token (long-lived)" hint="60-day token. Refresh before it expires."><input value={f.ig_access_token || ''} onChange={(ev) => set('ig_access_token', ev.target.value)} disabled={e?.meta?.envLocked?.accessToken} className="input font-mono" placeholder="IGAA…" /></Field>
            <Field label="App secret" hint="Used to verify webhook signatures. Recommended."><input value={f.meta_app_secret || ''} onChange={(ev) => set('meta_app_secret', ev.target.value)} disabled={e?.meta?.envLocked?.appSecret} className="input font-mono" placeholder="••••" /></Field>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button onClick={() => testMeta.mutate()} disabled={testMeta.isPending} className="btn btn-sm"><FlaskConical size={13} className={cn(testMeta.isPending && 'animate-pulse')} /> Test connection</button>
            <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm text-muted"><ExternalLink size={12} /> Meta for Developers</a>
            <span className="text-[12px] text-muted sm:ml-auto">Saved with “Save changes” above.</span>
          </div>
        </Disclosure>
      </section>

      <section id="companion" className="card p-6 mb-4 scroll-mt-20">
        <div className="flex items-center gap-2 mb-1"><Laptop size={16} className="text-accent" /><h2 className="text-[15px] font-semibold">Companion</h2><Link to="/import" className="ml-auto btn btn-ghost btn-sm text-muted">Pair a device <ArrowRight size={12} /></Link></div>
        <p className="text-[12.5px] text-muted mb-4 leading-relaxed">Chrome devices paired to this workspace. “Harvests in background” means the device stores its Instagram session here, encrypted, so saves keep syncing while the browser is closed; turn it off to delete that session, or remove the device to revoke it.</p>
        <CompanionDevices emptyHint="No devices paired yet. Install the Companion from the Import page and pair it with a code." />
      </section>

      <section id="data" className="card p-6 mb-6 scroll-mt-20">
        <div className="flex items-center gap-2 mb-1"><Download size={16} className="text-accent" /><h2 className="text-[15px] font-semibold">Data</h2></div>
        <p className="text-[12.5px] text-muted mb-3 leading-relaxed">Export everything (analyses, transcripts, tags, notes) at any time; filtered exports are on the Library page.</p>
        <div className="flex flex-wrap gap-2">
          {[['json', 'JSON'], ['csv', 'CSV'], ['md', 'Markdown digest'], ['obsidian', 'Obsidian vault (ZIP)']].map(([fmt, label]) => <a key={fmt} href={`/api/export?format=${fmt}`} className="btn btn-sm"><Download size={12} /> {label}</a>)}
        </div>
        {hostedTenant && (
          <div className="mt-5 rounded-xl border border-danger/30 p-4">
            <div className="flex items-center gap-2 mb-1"><Trash2 size={14} className="text-danger" /><h3 className="text-[13.5px] font-semibold">Delete account</h3></div>
            <p className="text-[12.5px] text-muted leading-relaxed">Disconnects Instagram, then removes your saves, media, analyses, conversations, rules, devices and settings from our servers. It does <strong>not</strong> cancel a subscription — cancel that in Billing first. This cannot be undone, so export first. <a href="/data-deletion" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">What exactly is deleted</a></p>
            <button onClick={() => { setConfirmText(''); setConfirmDelete(true); }} className="btn btn-danger btn-sm mt-3"><Trash2 size={13} /> Delete my account</button>
          </div>
        )}
      </section>

      {/* Reviewers (Meta, Chrome Web Store) and users both look for these from inside the product, not only in the footer. */}
      <section id="legal" className="card p-6 mb-6 scroll-mt-20">
        <div className="flex items-center gap-2 mb-1"><FileText size={16} className="text-accent" /><h2 className="text-[15px] font-semibold">Policies</h2></div>
        <p className="text-[12.5px] text-muted mb-3 leading-relaxed">What we store, who processes it, how long we keep it, and how to remove it.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-[12.5px]">
          {[['Privacy', '/privacy'], ['Data deletion', '/data-deletion'], ['Subprocessors', '/subprocessors'], ['Security', '/security'], ['Extension privacy', '/privacy/extension'], ['Terms', '/terms'], ['Credits', '/credits-terms'], ['Refunds', '/refunds'], ['Data processing (DPA)', '/dpa']].map(([label, href]) => (
            <a key={href} href={href} target="_blank" rel="noreferrer" className="text-ink-2 hover:text-ink underline underline-offset-2">{label}</a>
          ))}
        </div>
      </section>

      {/* ---------------- Engine ---------------- */}
      {!hostedTenant && (
        <>
          <div className="eyebrow mb-2">Engine</div>
          <section className="card p-6 mb-4">
            <div className="flex items-center gap-2 mb-4"><KeyRound size={16} className="text-accent" /><h2 className="text-[15px] font-semibold">OpenAI</h2><span className="ml-auto text-[12px] text-muted">{e?.openai}</span></div>
            <div className="grid gap-4">
              <Field label="API key" hint={locked('openai_api_key') ? 'Set by the OPENAI_API_KEY environment variable.' : 'Stored in the database on your volume; leave blank to remove.'}>
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
            <Field label={`Concurrency: ${conc} save${conc > 1 ? 's' : ''} at a time`} hint="Higher is faster but more likely to hit OpenAI rate limits on new accounts; 2–4 is a good range.">
              <input type="range" min={1} max={8} value={conc} onChange={(ev) => setConc(Number(ev.target.value))} className="w-full accent-[var(--accent)]" />
            </Field>
            <div className="mt-3 grid sm:grid-cols-2 gap-2 text-[12.5px] text-muted">
              <div>ffmpeg: <code className="font-mono text-ink">{e?.ffmpeg}</code></div>
              <div>keep videos: <code className="font-mono text-ink">{String(e?.keepVideos)}</code></div>
              <div>data dir: <code className="font-mono text-ink">{e?.dataDir}</code></div>
              <div>public URL: <code className="font-mono text-ink">{e?.publicUrl || '(auto)'}</code></div>
            </div>
            <div className="mt-4 flex items-center gap-2"><button onClick={() => reindex.mutate()} disabled={reindex.isPending} className="btn btn-sm"><RefreshCw size={13} className={reindex.isPending ? 'animate-spin' : ''} /> Rebuild search index</button><span className="text-[12px] text-muted">Also refreshes similarity; safe to run any time.</span></div>
          </section>
        </>
      )}

      <section className="card p-6">
        <div className="flex items-center gap-2 mb-3"><Database size={16} className="text-accent" /><h2 className="text-[15px] font-semibold">Storage</h2></div>
        <div className="grid sm:grid-cols-3 gap-3 text-[13px]">
          <div className="card-flat p-3"><div className="eyebrow mb-1"><HardDrive size={10} className="inline mr-1" />Media</div><div className="display text-[22px]">{q.data ? fmtBytes(q.data.storage.mediaBytes) : '—'}</div></div>
          <div className="card-flat p-3"><div className="eyebrow mb-1">Database</div><div className="display text-[22px]">{q.data ? fmtBytes(q.data.storage.dbBytes) : '—'}</div></div>
          <div className="card-flat p-3"><div className="eyebrow mb-1">Version</div><div className="display text-[22px]">v{q.data?.version}</div></div>
        </div>
        {!hostedTenant && <div className="mt-3 text-[12px] text-muted">Thumbnails and video frames are kept; videos are discarded after transcription unless KEEP_VIDEOS=true. Back up the data directory to keep everything.</div>}
        {hostedTenant && <div className="mt-3 text-[12px] text-muted inline-flex items-center gap-1.5"><Plug size={12} /> Hosted workspace #{auth.tenantId} · <Link to="/billing" className="underline hover:text-ink">plan and usage</Link></div>}
      </section>

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} width="max-w-md">
        <div className="p-6">
          <div className="eyebrow mb-1">Danger zone</div>
          <h3 className="display text-[24px] mb-2">Delete this account?</h3>
          <p className="text-[13px] text-ink-2 leading-relaxed">All saves, media, analyses, conversations, automation rules, paired devices and settings will be removed, and the Instagram connection deleted. An active subscription is <strong>not</strong> cancelled by this — do that in Billing first. Type <code className="font-mono">DELETE</code> to confirm.</p>
          <input value={confirmText} onChange={(ev) => setConfirmText(ev.target.value)} className="input mt-4 font-mono" placeholder="DELETE" autoFocus />
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setConfirmDelete(false)} className="btn">Cancel</button>
            <button onClick={doDelete} disabled={confirmText !== 'DELETE' || deleting} className="btn btn-danger">{deleting ? 'Deleting…' : 'Delete everything'}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
