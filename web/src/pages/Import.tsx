import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { Upload, Copy, Bookmark, FileJson, FileArchive, Link2, CheckCircle2, AlertCircle, Loader2, Terminal, ArrowRight } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, Tabs, Field, Toggle } from '../components/ui';
import { AnalysisPlan } from '../components/AnalysisPlan';
import { useWorkerStatus } from '../components/Shell';
import { cn, copyText, fmtAgo } from '../lib/utils';

type Tab = 'harvester' | 'export' | 'urls';

function DropZone({ accept, onFile, label, hint, busy }: { accept: string; onFile: (f: File) => void; label: string; hint: string; busy?: boolean }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
      onClick={() => inputRef.current?.click()}
      className={cn('cursor-pointer rounded-2xl border-2 border-dashed p-8 text-center transition-colors', over ? 'border-accent bg-accent-soft/40' : 'border-line hover:border-line-2 bg-surface')}
    >
      <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      {busy ? <Loader2 className="mx-auto mb-2 animate-spin text-accent" /> : <Upload className="mx-auto mb-2 text-muted" />}
      <div className="text-[14px] font-medium">{busy ? 'Uploading & importing…' : label}</div>
      <div className="text-[12px] text-muted mt-1">{hint}</div>
    </div>
  );
}

export default function Import() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('harvester');
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [includeLiked, setIncludeLiked] = useState(false);
  const [urls, setUrls] = useState('');
  const [script, setScript] = useState<string>('');
  const bookmarkletRef = useRef<HTMLAnchorElement>(null);
  const worker = useWorkerStatus();
  const history = useQuery({ queryKey: ['imports'], queryFn: () => api.get<{ imports: any[] }>('/api/import/history') });
  const token = useQuery({ queryKey: ['upload-token'], queryFn: () => api.post<{ token: string; expiresAt: number }>('/api/import/token'), staleTime: 60 * 60_000 });
  useEffect(() => { fetch('/harvester.js').then((r) => r.text()).then(setScript).catch(() => {}); }, []);
  // The script we hand out embeds a private 24h upload token so the harvester can "Send to Resurface" directly.
  const personalScript = script ? script.replace(/__RESURFACE_TOKEN__/g, token.data?.token || '__RESURFACE_TOKEN__') : '';
  const bookmarklet = personalScript ? `javascript:${encodeURIComponent(personalScript.replace(/^\/\*[\s\S]*?\*\/\s*/, ''))}` : '';
  // React refuses to render javascript: URLs in href — set it through the DOM so the drag-to-bookmarks-bar gesture keeps the real code.
  useEffect(() => { if (bookmarkletRef.current) bookmarkletRef.current.setAttribute('href', bookmarklet || '#'); }, [bookmarklet]);

  const done = (r: any) => {
    toast.success(`Imported ${r.total}: ${r.created} new, ${r.updated} updated${r.queued ? ` · ${r.queued} queued for analysis` : ''}`);
    qc.invalidateQueries({ queryKey: ['items'] }); qc.invalidateQueries({ queryKey: ['stats'] }); qc.invalidateQueries({ queryKey: ['jobs-status'] }); qc.invalidateQueries({ queryKey: ['imports'] }); qc.invalidateQueries({ queryKey: ['facets'] });
  };
  const upHarvest = useMutation({ mutationFn: (f: File) => { const fd = new FormData(); fd.append('file', f); fd.append('auto_analyze', autoAnalyze ? '1' : '0'); return api.post<any>('/api/import/harvest', fd); }, onSuccess: done, onError: (e: any) => toast.error(e.message) });
  const upExport = useMutation({ mutationFn: (f: File) => { const fd = new FormData(); fd.append('file', f); fd.append('auto_analyze', autoAnalyze ? '1' : '0'); fd.append('include_liked', includeLiked ? '1' : '0'); return api.post<any>('/api/import/instagram-export', fd); }, onSuccess: done, onError: (e: any) => toast.error(e.message) });
  const upUrls = useMutation({ mutationFn: () => api.post<any>('/api/import/urls', { urls, auto_analyze: autoAnalyze }), onSuccess: (r) => { done(r); setUrls(''); }, onError: (e: any) => toast.error(e.message) });
  const copyScript = useCallback(() => { copyText(personalScript); toast.success('Harvester script copied — paste it into the DevTools console on instagram.com'); }, [personalScript]);

  const w = worker.data;
  return (
    <div>
      <PageHeader eyebrow="Import" title={<>Bring your saves <em className="text-accent not-italic">home</em></>} subtitle="Three ways in. The harvester is the richest (captions, stats, media for transcripts and frames). Re-running any import is safe: existing saves are updated, never duplicated." />

      {/* Analysis plan: scope, cost, worker controls */}
      <div className="mb-8">
        <AnalysisPlan />
        {w && !w.openaiConfigured && <div className="mt-3 text-[12.5px] text-warn flex items-center gap-1.5"><AlertCircle size={13} /> OpenAI key missing — imports still work (and media gets fetched), but analysis waits until you add a key in Settings.</div>}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'harvester', label: <span className="inline-flex items-center gap-1.5"><Terminal size={13} /> Harvester (best)</span> }, { id: 'export', label: <span className="inline-flex items-center gap-1.5"><FileArchive size={13} /> Instagram data export</span> }, { id: 'urls', label: <span className="inline-flex items-center gap-1.5"><Link2 size={13} /> Paste URLs</span> }]} />
        <Toggle checked={autoAnalyze} onChange={setAutoAnalyze} label="Analyze automatically after import" />
      </div>

      {tab === 'harvester' && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="grid lg:grid-cols-[1.1fr_1fr] gap-4">
          <div className="card p-6">
            <div className="eyebrow mb-3">How it works</div>
            <ol className="space-y-4 text-[13.5px]">
              {[
                ['Open instagram.com in a desktop browser', 'Make sure you’re logged in to the account whose saves you want.'],
                ['Run the harvester there', <>Either click the bookmarklet below on instagram.com, or open DevTools (F12 → Console), paste the script and hit Enter. Chrome may ask you to type <code className="font-mono">allow pasting</code> first.</>],
                ['Press Start and wait', 'A small panel appears. It pages through your saves at ~1 request/second (Instagram is slow on big libraries — a few thousand saves can take 20–40 minutes; you can Stop and later Start again to resume).'],
                ['Send to Resurface (or drop the JSON here)', 'When it finishes, click “Send to Resurface” — the script you copied embeds a private 24-hour upload token, so it posts straight into this dashboard. Or “Download JSON” and drop the file below. Media links expire in a few days, so don’t wait. Analysis then runs in the background.'],
              ].map(([t, d], i) => (
                <li key={i} className="flex gap-3"><span className="font-mono text-[11px] text-accent pt-1 w-5 shrink-0">{String(i + 1).padStart(2, '0')}</span><div><div className="font-medium">{t}</div><div className="text-muted mt-0.5 leading-relaxed">{d}</div></div></li>
              ))}
            </ol>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <button onClick={copyScript} disabled={!script} className="btn btn-primary"><Copy size={14} /> Copy console script</button>
              <a ref={bookmarkletRef} onClick={(e) => { e.preventDefault(); toast('Drag this button to your bookmarks bar, then click it on instagram.com'); }} draggable className={cn('btn', !bookmarklet && 'opacity-50')} title="Drag me to your bookmarks bar"><Bookmark size={14} /> Harvest saves (bookmarklet)</a>
              <a href="/harvester.js" target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm text-muted">View source</a>
            </div>
            <div className="mt-4 text-[12px] text-muted leading-relaxed">Privacy: the script only talks to instagram.com using your own session and writes a file to your computer. Nothing is sent anywhere else. It respects rate limits and stops politely on errors.</div>
          </div>
          <div className="flex flex-col gap-4">
            <DropZone accept=".json,application/json" onFile={(f) => upHarvest.mutate(f)} busy={upHarvest.isPending} label="Drop the harvester JSON here" hint="resurface-harvest-YYYYMMDD.json · or click to choose" />
            <div className="card-flat p-4 text-[12.5px] text-muted leading-relaxed"><FileJson size={14} className="inline mr-1.5 -mt-0.5 text-ink" />Re-running the harvester later only adds new saves and refreshes counts. Your notes, favorites and analyses are kept.</div>
          </div>
        </motion.div>
      )}

      {tab === 'export' && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="grid lg:grid-cols-[1.1fr_1fr] gap-4">
          <div className="card p-6">
            <div className="eyebrow mb-3">Official Instagram data export</div>
            <ol className="space-y-4 text-[13.5px]">
              {[
                ['Request your data', <>Instagram app → Settings → <b>Accounts Center</b> → Your information and permissions → <b>Download your information</b> → Download or transfer information → select your Instagram profile → <b>Some of your information</b> → tick <b>Saved</b> (and Likes if you want) → Download to device → format <b>JSON</b>, media quality low → Create files.</>],
                ['Wait for the email', 'Usually minutes to a couple of days. Download the ZIP (it can be split in parts — upload each).'],
                ['Upload the ZIP here', 'We read saved_posts.json and saved_collections.json. This gives you links + save dates + collections. Captions/thumbnails are then fetched best-effort from public embed pages; for full media & transcripts use the harvester too — both merge into the same saves.'],
              ].map(([t, d], i) => (
                <li key={i} className="flex gap-3"><span className="font-mono text-[11px] text-accent pt-1 w-5 shrink-0">{String(i + 1).padStart(2, '0')}</span><div><div className="font-medium">{t}</div><div className="text-muted mt-0.5 leading-relaxed">{d}</div></div></li>
              ))}
            </ol>
            <div className="mt-4"><Toggle checked={includeLiked} onChange={setIncludeLiked} label="Also import liked posts (as a “Liked” collection)" /></div>
          </div>
          <DropZone accept=".zip,application/zip" onFile={(f) => upExport.mutate(f)} busy={upExport.isPending} label="Drop the Instagram export ZIP here" hint="instagram-username-date-xxxx.zip (JSON format)" />
        </motion.div>
      )}

      {tab === 'urls' && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="grid lg:grid-cols-[1.1fr_1fr] gap-4">
          <div className="card p-6">
            <div className="eyebrow mb-3">Paste post / reel links</div>
            <p className="text-[13.5px] text-muted leading-relaxed">One per line (or comma-separated). Handy for saves from other people’s screenshots, DMs, or anything you want in the library without saving it on Instagram. Captions and thumbnails are fetched from public embed pages when possible; reels may also be transcribed.</p>
            <Field label="Links">
              <textarea value={urls} onChange={(e) => setUrls(e.target.value)} rows={7} placeholder={'https://www.instagram.com/reel/AbC123/\nhttps://www.instagram.com/p/XyZ789/'} className="input font-mono text-[12px]" />
            </Field>
            <button onClick={() => upUrls.mutate()} disabled={!urls.trim() || upUrls.isPending} className="btn btn-primary mt-3">{upUrls.isPending ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />} Import links</button>
          </div>
        </motion.div>
      )}

      {/* History */}
      <div className="mt-8">
        <div className="eyebrow mb-2">Import history</div>
        {history.data?.imports.length ? (
          <div className="card-flat divide-y divide-line">
            {history.data.imports.map((h) => (
              <div key={h.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                <CheckCircle2 size={14} className="text-accent shrink-0" />
                <span className="font-medium capitalize">{h.source}</span>
                <span className="text-muted truncate">{h.filename || ''}</span>
                <span className="ml-auto font-mono text-[11.5px] text-muted shrink-0">{h.total} total · {h.created} new · {h.updated} updated</span>
                <span className="text-[11.5px] text-muted shrink-0 w-24 text-right">{fmtAgo(h.created_at)}</span>
              </div>
            ))}
          </div>
        ) : <div className="text-[13px] text-muted">No imports yet.</div>}
      </div>
    </div>
  );
}
