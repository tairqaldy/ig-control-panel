import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, ExternalLink, Heart, RefreshCw, Trash2, Copy, Archive, ChevronDown, ChevronUp, Sparkles, Quote, ListChecks, Tag, Users, Music2, MapPin, Eye, Play, Images, FileText, Wand2, MessageSquareText, Save, Loader2, AlertCircle } from 'lucide-react';
import { api } from '../lib/api';
import type { ItemFull, ItemLight } from '../lib/types';
import { useItemModal } from '../lib/store';
import { cn, fmtDate, fmtNum, fmtDuration, copyText, CONTENT_TYPE_LABEL, ACTION_LABEL } from '../lib/utils';
import { Modal, Skeleton, CategoryDot } from './ui';

function Section({ icon, title, children, defaultOpen = true, count }: { icon?: React.ReactNode; title: string; children: React.ReactNode; defaultOpen?: boolean; count?: number }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-line first:border-t-0 py-3.5">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 text-left">
        {icon && <span className="text-muted">{icon}</span>}
        <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-2">{title}</span>
        {count !== undefined && <span className="font-mono text-[10.5px] text-muted">{count}</span>}
        <span className="ml-auto text-muted">{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
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
  useEffect(() => { if (item) { setNotes(item.user_notes || ''); setTagsInput(item.user_tags.join(', ')); setDirty(false); setFrameIdx(0); } }, [item?.id, item?.updated_at]);

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['item', id] }); qc.invalidateQueries({ queryKey: ['items'] }); qc.invalidateQueries({ queryKey: ['stats'] }); qc.invalidateQueries({ queryKey: ['facets'] }); };
  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch(`/api/items/${id}`, body), onSuccess: invalidate });
  const reanalyze = useMutation({ mutationFn: (media: boolean) => api.post(`/api/items/${id}/reanalyze`, { media }), onSuccess: () => { toast.success('Queued for re-analysis'); invalidate(); qc.invalidateQueries({ queryKey: ['jobs-status'] }); } });
  const del = useMutation({ mutationFn: () => api.del(`/api/items/${id}`), onSuccess: () => { toast.success('Deleted'); modal.close(); invalidate(); } });

  const images = useMemo(() => (item ? (item.frames.length ? item.frames : item.thumb ? [item.thumb] : []) : []), [item]);
  const a = item?.analysis || null;

  const saveNotes = () => patch.mutate({ user_notes: notes, user_tags: tagsInput.split(',').map((s) => s.trim()).filter(Boolean) }, { onSuccess: () => { setDirty(false); toast.success('Saved'); } });

  return (
    <Modal open={!!id} onClose={modal.close} width="max-w-6xl">
      {!item ? (
        <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-6 p-6">
          <Skeleton className="aspect-[4/5] w-full" />
          <div className="space-y-3"><Skeleton className="h-8 w-3/4" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></div>
        </div>
      ) : (
        <div className="grid md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)] max-h-[calc(100vh-3rem)]">
          {/* Media column */}
          <div className="md:sticky md:top-0 md:self-start p-4 md:p-5 md:border-r border-line bg-bg-2/40 rounded-l-2xl">
            <div className="relative aspect-[4/5] overflow-hidden rounded-xl bg-surface-2 border border-line">
              {images.length ? (
                <AnimatePresence mode="wait">
                  <motion.img key={images[frameIdx]} src={images[frameIdx]} alt="" className="h-full w-full object-cover" initial={{ opacity: 0.4 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
                </AnimatePresence>
              ) : (
                <div className="h-full w-full grid place-items-center text-muted p-8 text-center text-[13px]"><div><FileText className="mx-auto mb-2" />{item.media_status === 'expired' ? 'Media links expired before they could be fetched. Re-run the harvester to refresh.' : 'No preview available'}</div></div>
              )}
              <div className="absolute left-2 top-2 flex gap-1">
                {item.media_type === 'video' && <span className="inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white backdrop-blur"><Play size={10} className="fill-white" />{fmtDuration(item.duration) || 'Reel'}</span>}
                {item.media_type === 'carousel' && <span className="inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white backdrop-blur"><Images size={10} />Carousel</span>}
              </div>
            </div>
            {images.length > 1 && (
              <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
                {images.map((src, i) => (
                  <button key={src} onClick={() => setFrameIdx(i)} className={cn('h-14 w-11 shrink-0 overflow-hidden rounded-md border transition-all', i === frameIdx ? 'border-accent ring-2 ring-accent/20' : 'border-line opacity-70 hover:opacity-100')}>
                    <img src={src} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
              {item.author && <a href={`https://www.instagram.com/${item.author}/`} target="_blank" rel="noreferrer" className="text-ink hover:text-accent font-medium">@{item.author}</a>}
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
            <div className="mt-4 grid grid-cols-2 gap-2">
              <a href={item.url} target="_blank" rel="noreferrer" className="btn btn-primary"><ExternalLink size={14} /> Open on Instagram</a>
              <button onClick={() => patch.mutate({ favorite: !item.favorite })} className={cn('btn', item.favorite && 'border-danger/40 text-danger')}><Heart size={14} className={cn(item.favorite && 'fill-danger')} />{item.favorite ? 'Favorited' : 'Favorite'}</button>
              <button onClick={() => { copyText(toMarkdown(item)); toast.success('Markdown copied'); }} className="btn"><Copy size={14} /> Copy as Markdown</button>
              <button onClick={() => { modal.close(); nav(`/ask?q=${encodeURIComponent(`Tell me more about "${a?.title || item.id}" and related saves`)}`); }} className="btn"><MessageSquareText size={14} /> Ask about this</button>
              <button onClick={() => reanalyze.mutate(false)} disabled={reanalyze.isPending} className="btn"><RefreshCw size={14} className={cn(reanalyze.isPending && 'animate-spin')} /> Re-analyze</button>
              <button onClick={() => reanalyze.mutate(true)} disabled={reanalyze.isPending} className="btn" title="Re-download media (frames, transcript) then re-analyze"><Wand2 size={14} /> Redo media + analysis</button>
              <button onClick={() => patch.mutate({ archived: !item.archived }, { onSuccess: () => { toast.success(item.archived ? 'Restored' : 'Archived'); if (!item.archived) modal.close(); } })} className="btn"><Archive size={14} />{item.archived ? 'Unarchive' : 'Archive'}</button>
              <button onClick={() => { if (confirm('Delete this save from Resurface? (Does not touch Instagram)')) del.mutate(); }} className="btn btn-danger"><Trash2 size={14} /> Delete</button>
            </div>
          </div>

          {/* Content column */}
          <div className="p-5 md:p-7 md:overflow-y-auto">
            {modal.history.length > 1 && <button onClick={modal.back} className="btn btn-ghost btn-sm mb-2 -ml-2"><ArrowLeft size={14} /> Back</button>}
            {a ? (
              <>
                <div className="flex items-center gap-2 text-[12px] text-muted mb-2">
                  <span className="inline-flex items-center gap-1.5 text-ink-2"><CategoryDot category={a.category} />{a.category}</span>
                  {a.subcategory && <><span>·</span><span>{a.subcategory}</span></>}
                  <span>·</span><span>{CONTENT_TYPE_LABEL[a.content_type] || a.content_type}</span>
                  <span className="ml-auto font-mono text-[10.5px]" title="Usefulness score (1-10) and evergreen flag">{a.usefulness_score}/10{a.is_evergreen ? ' · evergreen' : ''}</span>
                </div>
                <h2 className="display text-[30px] leading-[1.1] mb-2 pr-8">{a.title}</h2>
                <p className="text-[15px] text-ink-2 leading-relaxed">{a.one_liner}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {a.tags.map((t) => <button key={t} onClick={() => { modal.close(); nav(`/library?tag=${encodeURIComponent(t)}`); }} className="chip"><Tag size={11} />{t}</button>)}
                  {item.user_tags.map((t) => <span key={`u-${t}`} className="chip chip-active">{t}</span>)}
                </div>

                <div className="mt-5">
                  <Section title="Summary" icon={<FileText size={14} />}>
                    <p>{a.summary}</p>
                    <div className="mt-2 text-[12.5px] text-muted italic">Why you probably saved it: {a.why_saved_guess}</div>
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
                  {(a.hook.text || a.remix_idea) && (
                    <Section title="For creators" icon={<Wand2 size={14} />} defaultOpen={false}>
                      {a.hook.text && <div className="mb-2"><span className="eyebrow">Hook · {a.hook.style.replace('_', ' ')}</span><div className="mt-1">“{a.hook.text}”</div></div>}
                      {a.format_notes && <div className="mb-2"><span className="eyebrow">Format</span><div className="mt-1">{a.format_notes}</div></div>}
                      {a.remix_idea && <div><span className="eyebrow">Remix idea</span><div className="mt-1">{a.remix_idea}</div></div>}
                    </Section>
                  )}
                  {a.quotes.length > 0 && (
                    <Section title="Quotes" icon={<Quote size={14} />} count={a.quotes.length} defaultOpen={false}>
                      <div className="space-y-2">{a.quotes.map((q, i) => <blockquote key={i} className="border-l-2 border-accent pl-3 text-ink-2 italic">“{q}”</blockquote>)}</div>
                    </Section>
                  )}
                  {Object.values(a.entities).some((v) => v.length) && (
                    <Section title="Entities" icon={<Users size={14} />} defaultOpen={false}>
                      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
                        {(Object.entries(a.entities) as Array<[string, string[]]>).filter(([, v]) => v.length).map(([k, v]) => (
                          <div key={k}><div className="eyebrow mb-1">{k.replace('_', ' & ')}</div><div className="flex flex-wrap gap-1">{v.map((e) => <button key={e} onClick={() => { modal.close(); nav(`/library?q=${encodeURIComponent(e)}`); }} className="chip">{e}</button>)}</div></div>
                        ))}
                      </div>
                    </Section>
                  )}
                  {a.on_screen_text && (
                    <Section title="On-screen text" defaultOpen={false}>
                      <pre className="whitespace-pre-wrap font-sans text-[13px] text-ink-2">{a.on_screen_text}</pre>
                    </Section>
                  )}
                  <Section title="My notes" defaultOpen={!!item.user_notes}>
                    <textarea value={notes} onChange={(e) => { setNotes(e.target.value); setDirty(true); }} rows={3} placeholder="Why does this matter to you? What will you do with it?" className="input resize-y" />
                    <input value={tagsInput} onChange={(e) => { setTagsInput(e.target.value); setDirty(true); }} placeholder="your own tags, comma separated" className="input mt-2" />
                    <div className="mt-2 flex justify-end"><button disabled={!dirty || patch.isPending} onClick={saveNotes} className="btn btn-primary btn-sm"><Save size={13} /> Save notes</button></div>
                  </Section>
                  {item.transcript && (
                    <Section title="Transcript" defaultOpen={false}>
                      <p className="whitespace-pre-wrap text-ink-2">{item.transcript}</p>
                      <button onClick={() => { copyText(item.transcript || ''); toast.success('Transcript copied'); }} className="btn btn-sm mt-2"><Copy size={12} /> Copy transcript</button>
                    </Section>
                  )}
                  {item.caption && (
                    <Section title="Original caption" defaultOpen={false}>
                      <p className="whitespace-pre-wrap text-ink-2">{item.caption}</p>
                    </Section>
                  )}
                  <div className="border-t border-line pt-3 mt-1 text-[11px] text-muted font-mono flex flex-wrap gap-x-4 gap-y-1">
                    <span>id {item.id}</span>{item.analysis_model && <span>model {item.analysis_model}</span>}<span>confidence {Math.round(a.confidence * 100)}%</span>{a.language && <span>lang {a.language}</span>}{item.media_status !== 'done' && <span>media {item.media_status}</span>}
                  </div>
                </div>
              </>
            ) : (
              <div>
                <h2 className="display text-[26px] leading-tight pr-8 mb-3">{item.author ? `@${item.author}` : 'Save'} <span className="text-muted">· not analyzed yet</span></h2>
                <div className="card-flat p-4 text-[13px] flex items-start gap-3">
                  {item.analysis_status === 'failed' || item.analysis_status === 'skipped' ? <AlertCircle className="text-danger shrink-0" size={18} /> : <Loader2 className="animate-spin text-accent shrink-0" size={18} />}
                  <div>
                    <div className="font-medium">{item.analysis_status === 'failed' ? 'Analysis failed' : item.analysis_status === 'skipped' ? 'Not enough content to analyze' : item.queue_state === 'running' ? 'Analyzing right now…' : 'Waiting in the queue'}</div>
                    {item.analysis_error && <div className="text-muted mt-1 break-words">{item.analysis_error}</div>}
                    {(item.analysis_status === 'failed' || item.analysis_status === 'skipped') && <button onClick={() => reanalyze.mutate(true)} className="btn btn-sm mt-3"><RefreshCw size={12} /> Retry with media</button>}
                  </div>
                </div>
                {item.caption && <div className="mt-5"><div className="eyebrow mb-1.5">Caption</div><p className="whitespace-pre-wrap text-[13.5px] text-ink-2">{item.caption}</p></div>}
                {item.transcript && <div className="mt-5"><div className="eyebrow mb-1.5">Transcript</div><p className="whitespace-pre-wrap text-[13.5px] text-ink-2">{item.transcript}</p></div>}
              </div>
            )}

            {q.data?.related && q.data.related.length > 0 && (
              <div className="mt-6">
                <div className="eyebrow mb-2">Related saves</div>
                <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-2">
                  {q.data.related.slice(0, 8).map((r) => (
                    <button key={r.id} onClick={() => modal.open(r.id)} className="group text-left" title={r.analysis?.title || ''}>
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
        </div>
      )}
    </Modal>
  );
}
