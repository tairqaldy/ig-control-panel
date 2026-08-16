import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, ExternalLink, Heart, RefreshCw, Trash2, Copy, Archive, ChevronDown, ChevronUp, Sparkles, Quote, ListChecks, Tag, Users, Music2, MapPin, Eye, EyeOff, UserX, Play, Images, FileText, Wand2, MessageSquareText, Save, Loader2, AlertCircle, MoreHorizontal, PenLine, Captions } from 'lucide-react';
import { api } from '../lib/api';
import type { ItemFull, ItemLight } from '../lib/types';
import { useItemModal } from '../lib/store';
import { cn, fmtDate, fmtNum, fmtDuration, copyText, CONTENT_TYPE_LABEL, ACTION_LABEL } from '../lib/utils';
import { Modal, Skeleton, CategoryDot, Popover } from './ui';

function Section({ icon, title, children, defaultOpen = true, count, hint }: { icon?: React.ReactNode; title: string; children: React.ReactNode; defaultOpen?: boolean; count?: number; hint?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-line first:border-t-0 py-3.5">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 text-left rounded-md">
        {icon && <span className="text-muted">{icon}</span>}
        <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-2">{title}</span>
        {count !== undefined && <span className="font-mono text-[10.5px] text-muted">{count}</span>}
        {hint && <span className="text-[11.5px] text-muted truncate">{hint}</span>}
        <span className="ml-auto text-muted shrink-0">{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }} className="overflow-hidden">
            <div className="pt-2.5 text-[13.5px] leading-relaxed text-ink">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function toMarkdown(it: ItemFull): string {
  const a = it.analysis;
  const L: string[] = [`# ${a?.title || it.id}`, ''];
  if (a?.one_liner) L.push(`> ${a.one_liner}`, '');
  L.push(`${it.author ? `by @${it.author} · ` : ''}[Instagram](${it.url})${a ? ` · ${a.category}${a.subcategory ? ` / ${a.subcategory}` : ''}` : ''}`, '');
  if (a) {
    if (a.summary) L.push('## Summary', a.summary, '');
    if (a.key_points.length) L.push('## Key points', ...a.key_points.map((k) => `- ${k}`), '');
    if (a.actionable_takeaways.length) L.push('## Do this', ...a.actionable_takeaways.map((k) => `- [ ] ${k}`), '');
    if (a.quotes.length) L.push('## Quotes', ...a.quotes.map((q) => `> ${q}`), '');
    if (a.remix_idea) L.push('## Remix idea', a.remix_idea, '');
    L.push(`Tags: ${a.tags.map((t) => `#${t}`).join(' ')}`, '');
  }
  if (it.user_notes) L.push('## My notes', it.user_notes, '');
  if (it.transcript) L.push('## Transcript', it.transcript, '');
  return L.join('\n');
}

const wordCount = (s: string | null | undefined) => (s ? s.trim().split(/\s+/).filter(Boolean).length : 0);

function MenuItem({ icon, label, onClick, danger, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button role="menuitem" onClick={onClick} disabled={disabled} className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-surface-2 disabled:opacity-50', danger ? 'text-danger' : 'text-ink')}>
      <span className={cn('shrink-0', danger ? 'text-danger' : 'text-muted')}>{icon}</span><span className="truncate">{label}</span>
    </button>
  );
}

export function ItemModal() {
  const modal = useItemModal();
  const id = modal.openId;
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['item', id], queryFn: () => api.get<{ item: ItemFull; related: ItemLight[] }>(`/api/items/${id}`), enabled: !!id, refetchInterval: (query) => { const s = query.state.data?.item.analysis_status; return s === 'running' || s === 'pending' ? 4000 : false; } });
  const item = q.data?.item;
  const [notes, setNotes] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [frameIdx, setFrameIdx] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreAnchor, setMoreAnchor] = useState<HTMLButtonElement | null>(null);
  // Reset the editor when a different item opens; on background refetches of the same item keep unsaved edits.
  useEffect(() => { if (item) { setNotes(item.user_notes || ''); setTagsInput(item.user_tags.join(', ')); setDirty(false); setFrameIdx(0); setMoreOpen(false); } }, [item?.id]);
  useEffect(() => { if (item && !dirty) { setNotes(item.user_notes || ''); setTagsInput(item.user_tags.join(', ')); } }, [item?.updated_at]);

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['item', id] }); qc.invalidateQueries({ queryKey: ['items'] }); qc.invalidateQueries({ queryKey: ['stats'] }); qc.invalidateQueries({ queryKey: ['facets'] }); };
  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch(`/api/items/${id}`, body), onSuccess: invalidate, onError: (e: any) => toast.error(e?.message || 'Could not save the change') });
  const reanalyze = useMutation({ mutationFn: (media: boolean) => api.post(`/api/items/${id}/reanalyze`, { media }), onSuccess: () => { toast.success('Queued for re-analysis'); invalidate(); qc.invalidateQueries({ queryKey: ['jobs-status'] }); }, onError: (e: any) => toast.error(e?.message || 'Could not queue re-analysis') });
  const del = useMutation({ mutationFn: () => api.del(`/api/items/${id}`), onSuccess: () => { toast.success('Deleted'); modal.close(); invalidate(); }, onError: (e: any) => toast.error(e?.message || 'Could not delete') });
  const excludeAuthor = useMutation({ mutationFn: (author: string) => api.post<{ n: number }>('/api/items/exclude-author', { author }), onSuccess: (r) => { toast.success(`Excluded ${r.n} saves by that creator`); modal.close(); invalidate(); qc.invalidateQueries({ queryKey: ['scope'] }); } });

  const images = useMemo(() => (item ? (item.frames.length ? item.frames : item.thumb ? [item.thumb] : []) : []), [item]);
  const a = item?.analysis || null;
  const title = a?.title || (item?.caption ? item.caption.split('\n')[0].slice(0, 90) : item?.author ? `@${item.author}` : 'this save');

  const saveNotes = () => patch.mutate({ user_notes: notes, user_tags: tagsInput.split(',').map((s) => s.trim()).filter(Boolean) }, { onSuccess: () => { setDirty(false); toast.success('Notes saved'); } });
  const toBrief = () => { modal.close(); nav(`/ask?q=${encodeURIComponent(`Turn "${title}" into a content brief I can shoot this week: hook options, outline, CTA, format, and why it fits my taste. Cite the saves.`)}`); };
  const askAbout = () => { modal.close(); nav(`/ask?q=${encodeURIComponent(`Tell me more about "${title}" and related saves`)}`); };
  const closeMore = () => setMoreOpen(false);
  const related = q.data?.related || [];

  return (
    <Modal open={!!id} onClose={modal.close} width="max-w-6xl">
      {q.isError ? (
        <div className="p-8 text-center flex flex-col items-center gap-3">
          <AlertCircle size={24} className="text-danger" />
          <div className="display text-[22px]">This save did not load</div>
          <div className="text-[13px] text-muted max-w-sm">{(q.error as Error)?.message || 'The server did not answer.'}</div>
          <button onClick={() => q.refetch()} className="btn btn-primary mt-1"><RefreshCw size={14} /> Try again</button>
        </div>
      ) : !item ? (
        <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-6 p-6" aria-busy>
          <Skeleton className="aspect-[4/5] w-full" />
          <div className="space-y-3"><Skeleton className="h-8 w-3/4" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></div>
        </div>
      ) : (
        <div className="grid md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)] md:grid-rows-[minmax(0,1fr)_auto] md:h-[calc(100vh-3rem)] md:max-h-[calc(100vh-3rem)] md:overflow-hidden rounded-2xl">
          {/* Media column — scrolls on its own on desktop */}
          <div className="p-4 md:p-5 md:border-r border-line bg-bg-2/40 md:overflow-y-auto min-h-0 md:col-start-1 md:row-start-1">
            <div className="relative aspect-[4/5] overflow-hidden rounded-xl bg-surface-2 border border-line">
              {images.length ? (
                <AnimatePresence mode="wait">
                  <motion.img key={images[frameIdx]} src={images[frameIdx]} alt="" className="h-full w-full object-cover" initial={{ opacity: 0.4 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
                </AnimatePresence>
              ) : (
                <div className="h-full w-full grid place-items-center text-muted p-8 text-center text-[13px]"><div><FileText className="mx-auto mb-2" />{item.media_status === 'expired' ? 'Media links expired before they could be fetched. Sync again to refresh them.' : 'No preview for this save'}</div></div>
              )}
              <div className="absolute left-2 top-2 flex gap-1">
                {item.media_type === 'video' && <span className="inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white backdrop-blur"><Play size={10} className="fill-white" />{fmtDuration(item.duration) || 'Reel'}</span>}
                {item.media_type === 'carousel' && <span className="inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white backdrop-blur"><Images size={10} />Carousel</span>}
              </div>
            </div>
            {images.length > 1 && (
              <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Frames">
                {images.map((src, i) => (
                  <button key={src} role="tab" aria-selected={i === frameIdx} aria-label={`Frame ${i + 1}`} onClick={() => setFrameIdx(i)} className={cn('h-14 w-11 shrink-0 overflow-hidden rounded-md border transition-all', i === frameIdx ? 'border-accent ring-2 ring-accent/20' : 'border-line opacity-70 hover:opacity-100')}>
                    <img src={src} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
              {item.author && <a href={`https://www.instagram.com/${item.author}/`} target="_blank" rel="noreferrer" className="text-ink hover:text-accent font-medium rounded">@{item.author}</a>}
              {item.taken_at && <span>{fmtDate(item.taken_at)}</span>}
              {item.play_count ? <span className="inline-flex items-center gap-1 tabular"><Eye size={12} />{fmtNum(item.play_count)}</span> : null}
              {item.like_count ? <span className="inline-flex items-center gap-1 tabular"><Heart size={12} />{fmtNum(item.like_count)}</span> : null}
              {item.comment_count ? <span className="tabular">{fmtNum(item.comment_count)} comments</span> : null}
            </div>
            {(item.music || item.location) && (
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted">
                {item.music && <span className="inline-flex items-center gap-1 truncate max-w-full"><Music2 size={12} className="shrink-0" /><span className="truncate">{item.music}</span></span>}
                {item.location && <span className="inline-flex items-center gap-1"><MapPin size={12} />{item.location}</span>}
              </div>
            )}
            {item.collections.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{item.collections.map((c) => <span key={c} className="chip">{c}</span>)}</div>}
            {(item.archived || item.excluded) && (
              <div className="mt-3 text-[12px] text-muted inline-flex items-center gap-1.5">{item.excluded ? <><EyeOff size={12} /> Excluded: hidden everywhere, never analyzed.</> : <><Archive size={12} /> Archived.</>}</div>
            )}
          </div>

          {/* Content column */}
          <div className="p-5 md:p-7 md:overflow-y-auto min-h-0 md:col-start-2 md:row-start-1 md:row-span-2">
            {modal.history.length > 1 && <button onClick={modal.back} className="btn btn-ghost btn-sm mb-2 -ml-2"><ArrowLeft size={14} /> Back</button>}
            {a ? (
              <>
                <div className="flex items-center gap-2 text-[12px] text-muted mb-2 pr-8">
                  <span className="inline-flex items-center gap-1.5 text-ink-2"><CategoryDot category={a.category} />{a.category}</span>
                  {a.subcategory && <><span>·</span><span className="truncate">{a.subcategory}</span></>}
                  <span>·</span><span>{CONTENT_TYPE_LABEL[a.content_type] || a.content_type}</span>
                  <span className="ml-auto font-mono text-[10.5px] shrink-0" title="Usefulness score out of 10">{a.usefulness_score}/10{a.is_evergreen ? ' · evergreen' : ''}</span>
                </div>
                <h2 className="display text-[26px] sm:text-[30px] leading-[1.1] mb-2 pr-8">{a.title}</h2>
                <p className="text-[15px] text-ink-2 leading-relaxed">{a.one_liner}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {a.tags.map((t) => <button key={t} onClick={() => { modal.close(); nav(`/library?tag=${encodeURIComponent(t)}`); }} className="chip"><Tag size={11} />{t}</button>)}
                  {item.user_tags.map((t) => <span key={`u-${t}`} className="chip chip-active">{t}</span>)}
                </div>

                <div className="mt-5">
                  {/* Reading order: what it says → what to keep → what to do → how it was made → raw sources → your notes */}
                  <Section title="Summary" icon={<FileText size={14} />}>
                    <p>{a.summary}</p>
                    {a.why_saved_guess && <div className="mt-2 text-[12.5px] text-muted italic">Why you probably saved it: {a.why_saved_guess}</div>}
                  </Section>
                  {a.key_points.length > 0 && (
                    <Section title="Key points" icon={<ListChecks size={14} />} count={a.key_points.length}>
                      <ol className="space-y-1.5 list-none">
                        {a.key_points.map((k, i) => (
                          <li key={i} className="flex gap-3"><span className="font-mono text-[11px] text-accent pt-1 tabular w-5 shrink-0">{String(i + 1).padStart(2, '0')}</span><span>{k}</span></li>
                        ))}
                      </ol>
                    </Section>
                  )}
                  {a.actionable_takeaways.length > 0 && (
                    <Section title={`Do this · ${ACTION_LABEL[a.action_type] || a.action_type}`} icon={<Sparkles size={14} />} count={a.actionable_takeaways.length}>
                      <ul className="space-y-1.5">
                        {a.actionable_takeaways.map((k, i) => (
                          <li key={i} className="flex gap-2.5 items-start"><span className="mt-[7px] h-1.5 w-1.5 rounded-full bg-accent shrink-0" /><span>{k}</span></li>
                        ))}
                      </ul>
                    </Section>
                  )}
                  {(a.hook.text || a.remix_idea || a.format_notes) && (
                    <Section title="For creators" icon={<Wand2 size={14} />} defaultOpen={false} hint="hook · format · remix">
                      {a.hook.text && <div className="mb-2"><span className="eyebrow">Hook · {a.hook.style.replace('_', ' ')}</span><div className="mt-1">“{a.hook.text}”</div></div>}
                      {a.format_notes && <div className="mb-2"><span className="eyebrow">Format</span><div className="mt-1">{a.format_notes}</div></div>}
                      {a.remix_idea && <div><span className="eyebrow">Remix idea</span><div className="mt-1">{a.remix_idea}</div></div>}
                      <button onClick={toBrief} className="btn btn-sm mt-3"><Wand2 size={12} /> Turn into a brief</button>
                    </Section>
                  )}
                  {a.quotes.length > 0 && (
                    <Section title="Quotes" icon={<Quote size={14} />} count={a.quotes.length} defaultOpen={false}>
                      <div className="space-y-2">{a.quotes.map((q, i) => <blockquote key={i} className="border-l-2 border-accent pl-3 text-ink-2 italic">“{q}”</blockquote>)}</div>
                    </Section>
                  )}
                  {item.transcript && (
                    <Section title="Transcript" icon={<Captions size={14} />} defaultOpen={false} hint={`${wordCount(item.transcript).toLocaleString()} words${item.transcript_lang ? ` · ${item.transcript_lang}` : ''}`}>
                      <p className="whitespace-pre-wrap text-ink-2">{item.transcript}</p>
                      <button onClick={() => { copyText(item.transcript || ''); toast.success('Transcript copied'); }} className="btn btn-sm mt-2"><Copy size={12} /> Copy transcript</button>
                    </Section>
                  )}
                  {a.on_screen_text && (
                    <Section title="On-screen text" defaultOpen={false}>
                      <pre className="whitespace-pre-wrap font-sans text-[13px] text-ink-2">{a.on_screen_text}</pre>
                    </Section>
                  )}
                  {item.caption && (
                    <Section title="Original caption" defaultOpen={false}>
                      <p className="whitespace-pre-wrap text-ink-2">{item.caption}</p>
                    </Section>
                  )}
                  {Object.values(a.entities).some((v) => v.length) && (
                    <Section title="Mentioned" icon={<Users size={14} />} defaultOpen={false} hint="people · brands · tools">
                      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
                        {(Object.entries(a.entities) as Array<[string, string[]]>).filter(([, v]) => v.length).map(([k, v]) => (
                          <div key={k}><div className="eyebrow mb-1">{k.replace('_', ' & ')}</div><div className="flex flex-wrap gap-1">{v.map((e) => <button key={e} onClick={() => { modal.close(); nav(`/library?q=${encodeURIComponent(e)}`); }} className="chip">{e}</button>)}</div></div>
                        ))}
                      </div>
                    </Section>
                  )}
                  <Section title="My notes" icon={<PenLine size={14} />} defaultOpen={!!item.user_notes || item.user_tags.length > 0} hint={item.user_notes ? undefined : 'private to you'}>
                    <textarea value={notes} onChange={(e) => { setNotes(e.target.value); setDirty(true); }} rows={3} placeholder="Why this matters to you, or what you'll do with it" aria-label="Notes" className="input resize-y" />
                    <input value={tagsInput} onChange={(e) => { setTagsInput(e.target.value); setDirty(true); }} placeholder="Your tags, comma separated" aria-label="Your tags" className="input mt-2" />
                    <div className="mt-2 flex items-center justify-end gap-2">
                      {dirty && <span className="text-[12px] text-muted">Unsaved changes</span>}
                      <button disabled={!dirty || patch.isPending} onClick={saveNotes} className="btn btn-primary btn-sm"><Save size={13} /> Save notes</button>
                    </div>
                  </Section>
                  <div className="border-t border-line pt-3 mt-1 text-[11px] text-muted font-mono flex flex-wrap gap-x-4 gap-y-1">
                    <span>id {item.id}</span>{item.analysis_model && <span>model {item.analysis_model}</span>}<span>confidence {Math.round(a.confidence * 100)}%</span>{a.language && <span>lang {a.language}</span>}{item.media_status !== 'done' && <span>media {item.media_status}</span>}
                  </div>
                </div>
              </>
            ) : (
              <div>
                <h2 className="display text-[24px] sm:text-[26px] leading-tight pr-8 mb-3">{item.author ? `@${item.author}` : 'Save'} <span className="text-muted">· not analyzed yet</span></h2>
                <div className="card-flat p-4 text-[13px] flex items-start gap-3">
                  {item.analysis_status === 'failed' || item.analysis_status === 'skipped' ? <AlertCircle className="text-danger shrink-0" size={18} /> : <Loader2 className="animate-spin text-accent shrink-0" size={18} />}
                  <div className="min-w-0">
                    <div className="font-medium">{item.analysis_status === 'failed' ? 'Analysis failed' : item.analysis_status === 'skipped' ? 'Not enough content to analyze' : item.queue_state === 'running' ? 'Analyzing right now…' : 'Waiting in the queue'}</div>
                    <div className="text-muted mt-1 break-words">{item.analysis_error || (item.analysis_status === 'skipped' ? 'No caption, transcript or readable frames were found.' : item.queue_state === 'running' ? 'Transcript, summary and tags appear here in a minute or two.' : 'This page updates by itself once the analysis lands.')}</div>
                    {(item.analysis_status === 'failed' || item.analysis_status === 'skipped') && <button onClick={() => reanalyze.mutate(true)} disabled={reanalyze.isPending} className="btn btn-primary btn-sm mt-3"><RefreshCw size={12} className={cn(reanalyze.isPending && 'animate-spin')} /> Retry with media</button>}
                  </div>
                </div>
                {item.caption && <div className="mt-5"><div className="eyebrow mb-1.5">Caption</div><p className="whitespace-pre-wrap text-[13.5px] text-ink-2">{item.caption}</p></div>}
                {item.transcript && <div className="mt-5"><div className="eyebrow mb-1.5">Transcript</div><p className="whitespace-pre-wrap text-[13.5px] text-ink-2">{item.transcript}</p></div>}
              </div>
            )}

            {related.length > 0 && (
              <div className="mt-6">
                <div className="flex items-baseline gap-2 mb-2"><div className="eyebrow">Similar saves</div><span className="text-[11.5px] text-muted">by meaning and tags</span></div>
                <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-2">
                  {related.slice(0, 8).map((r) => (
                    <button key={r.id} onClick={() => modal.open(r.id)} className="group text-left rounded-lg" title={r.analysis?.title || ''}>
                      <div className="aspect-[4/5] overflow-hidden rounded-lg border border-line bg-surface-2">
                        {r.thumb ? <img src={r.thumb} alt="" className="h-full w-full object-cover group-hover:scale-105 transition-transform duration-500" loading="lazy" /> : <div className="h-full w-full grid place-items-center text-muted-2"><FileText size={12} /></div>}
                      </div>
                      <div className="mt-1 text-[10.5px] leading-tight text-muted clamp-2">{r.analysis?.title || r.author}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Actions — sticky at the bottom on every viewport: one primary, two frequent, the rest behind "More" */}
          <div className="sticky bottom-0 z-10 md:static md:col-start-1 md:row-start-2 border-t md:border-r border-line bg-surface/95 md:bg-bg-2/60 backdrop-blur px-4 py-3 md:px-5 rounded-b-2xl md:rounded-bl-2xl md:rounded-br-none flex items-center gap-2">
            <a href={item.url} target="_blank" rel="noreferrer" className="btn btn-primary flex-1 min-w-0"><ExternalLink size={14} /><span className="truncate">Open on Instagram</span></a>
            <button onClick={() => patch.mutate({ favorite: !item.favorite })} aria-pressed={item.favorite} className={cn('btn', item.favorite && 'border-danger/40 text-danger')} title={item.favorite ? 'Remove from favorites' : 'Add to favorites'}><Heart size={14} className={cn(item.favorite && 'fill-danger')} /><span className="hidden sm:inline">{item.favorite ? 'Favorited' : 'Favorite'}</span></button>
            <button onClick={toBrief} className="btn" title="Open Ask with a content-brief request for this save"><Wand2 size={14} /><span className="hidden sm:inline">Turn into a brief</span></button>
            <button ref={setMoreAnchor} onClick={() => setMoreOpen((o) => !o)} aria-expanded={moreOpen} aria-haspopup="menu" aria-label="More actions" className={cn('btn !px-2.5', moreOpen && 'bg-surface-2')}><MoreHorizontal size={16} /></button>
            <Popover anchor={moreAnchor} open={moreOpen} onClose={closeMore} width={248} align="end">
              <div role="menu">
                <MenuItem icon={<MessageSquareText size={14} />} label="Ask about this" onClick={() => { closeMore(); askAbout(); }} />
                <MenuItem icon={<Copy size={14} />} label="Copy as Markdown" onClick={() => { closeMore(); copyText(toMarkdown(item)); toast.success('Markdown copied'); }} />
                <div className="my-1 divider" />
                <MenuItem icon={<RefreshCw size={14} />} label="Re-analyze" onClick={() => { closeMore(); reanalyze.mutate(false); }} disabled={reanalyze.isPending} />
                <MenuItem icon={<Wand2 size={14} />} label="Redo media and analysis" onClick={() => { closeMore(); reanalyze.mutate(true); }} disabled={reanalyze.isPending} />
                <div className="my-1 divider" />
                <MenuItem icon={<Archive size={14} />} label={item.archived ? 'Unarchive' : 'Archive'} onClick={() => { closeMore(); patch.mutate({ archived: !item.archived }, { onSuccess: () => { toast.success(item.archived ? 'Restored' : 'Archived'); if (!item.archived) modal.close(); } }); }} />
                <MenuItem icon={item.excluded ? <Eye size={14} /> : <EyeOff size={14} />} label={item.excluded ? 'Include again' : 'Exclude from Resurfly'} onClick={() => { closeMore(); patch.mutate({ excluded: !item.excluded }, { onSuccess: () => { toast.success(item.excluded ? 'Included again' : 'Excluded: hidden everywhere, never analyzed'); if (!item.excluded) modal.close(); } }); }} />
                {item.author && !item.excluded && <MenuItem icon={<UserX size={14} />} label={`Exclude everything by @${item.author}`} onClick={() => { closeMore(); if (confirm(`Exclude all saves by @${item.author} from Resurfly? You can undo this from Library → Filters → Excluded.`)) excludeAuthor.mutate(item.author!); }} />}
                <div className="my-1 divider" />
                <MenuItem icon={<Trash2 size={14} />} label="Delete from Resurfly" danger onClick={() => { closeMore(); if (confirm('Delete this save from Resurfly? Instagram is not touched.')) del.mutate(); }} />
              </div>
            </Popover>
          </div>
        </div>
      )}
    </Modal>
  );
}
