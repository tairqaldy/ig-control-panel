import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { motion } from 'motion/react';
import { ArrowRight, Sparkles, Upload, MessageSquareText, Waypoints, Clapperboard, Image as ImageIcon, Images, Mic, Heart, Users, Leaf } from 'lucide-react';
import { api } from '../lib/api';
import type { Stats, ItemLight } from '../lib/types';
import { PageHeader, Stat, Skeleton, CategoryDot, Empty } from '../components/ui';
import { ItemCard } from '../components/ItemCard';
import { useAuth } from '../lib/store';
import { CONTENT_TYPE_LABEL } from '../lib/utils';

function Bars({ rows, onClick, max }: { rows: Array<{ name: string; n: number }>; onClick?: (name: string) => void; max?: number }) {
  const top = rows.slice(0, max ?? 8);
  const m = Math.max(1, ...top.map((r) => r.n));
  return (
    <div className="space-y-2">
      {top.map((r, i) => (
        <button key={r.name || i} onClick={() => onClick?.(r.name)} className="group block w-full text-left">
          <div className="flex items-center justify-between text-[12.5px] mb-1">
            <span className="inline-flex items-center gap-2 truncate text-ink-2 group-hover:text-ink"><CategoryDot category={r.name} />{r.name || 'Uncategorized'}</span>
            <span className="font-mono text-[11px] text-muted tabular">{r.n}</span>
          </div>
          <div className="h-1.5 rounded-full bg-line overflow-hidden"><motion.div className="h-full rounded-full" style={{ background: `oklch(0.6 0.13 ${hue(r.name)})` }} initial={{ width: 0 }} animate={{ width: `${(r.n / m) * 100}%` }} transition={{ delay: i * 0.04, duration: 0.6, ease: [0.2, 0.7, 0.2, 1] }} /></div>
        </button>
      ))}
    </div>
  );
}
function hue(cat: string) { const m: Record<string, number> = { 'Business & Marketing': 28, 'Content Creation & Social Media': 340, 'Design & Visual Aesthetics': 280, 'Tech, AI & Tools': 210, 'Productivity & Mindset': 45, 'Money & Finance': 95, 'Health & Fitness': 160, 'Food & Recipes': 15, 'Travel & Places': 190, 'Fashion & Style': 320, 'Home & Interior': 60, 'Art & Creativity': 260, 'Music & Audio': 300, 'Photography & Video Craft': 240, 'Learning & Science': 200, 'Relationships & Communication': 355, 'Humor & Entertainment': 40, 'Personal & Sentimental': 10, Other: 0 }; if (m[cat] !== undefined) return m[cat]; let h = 0; for (let i = 0; i < (cat || '').length; i++) h = (h * 31 + cat.charCodeAt(i)) % 360; return h; }

function Timeline({ rows }: { rows: Array<{ month: string; n: number }> }) {
  const last = rows.slice(-24);
  const m = Math.max(1, ...last.map((r) => r.n));
  return (
    <div className="flex items-end gap-[3px] h-24">
      {last.map((r, i) => (
        <div key={r.month} className="group relative flex-1 min-w-[4px]">
          <motion.div className="w-full rounded-t-sm bg-accent/70 group-hover:bg-accent" initial={{ height: 0 }} animate={{ height: `${Math.max(3, (r.n / m) * 96)}px` }} transition={{ delay: i * 0.02, duration: 0.5 }} />
          <div className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-1.5 py-0.5 font-mono text-[10px] text-bg opacity-0 group-hover:opacity-100 transition-opacity">{r.month} · {r.n}</div>
        </div>
      ))}
    </div>
  );
}

const HERO_PROMPTS = [
  'What did I save about growing on Instagram?',
  'Give me the best AI tools from my saves',
  'Summarize the recurring themes in my library',
  'Which saved recipes can I cook tonight?',
  'What hooks do the reels I saved use?',
];

/** Big centered composer: the first thing you see. Submitting hands the question to /ask. */
function AskHero({ total, analyzed }: { total: number; analyzed: number }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const go = (question: string) => { const t = question.trim(); if (t) nav(`/ask?q=${encodeURIComponent(t)}`); };
  return (
    <section className="relative mb-8 rise">
      <div className="mx-auto max-w-3xl text-center pt-4 pb-6">
        <div className="eyebrow mb-3">Ask your saves</div>
        <h1 className="display text-[40px] sm:text-[52px] leading-[1.02] tracking-tight">What did you save about…</h1>
        <p className="mt-3 text-[14.5px] text-muted max-w-xl mx-auto">Everything you ever saved on Instagram, transcribed and structured. Ask in plain language — answers cite the exact saves.</p>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); go(q); }} className="mx-auto max-w-2xl">
        <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface p-2 pl-4 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/10 transition-all" style={{ boxShadow: 'var(--shadow-lg)' }}>
          <MessageSquareText size={18} className="text-muted shrink-0" />
          <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="e.g. what were the cold-email tips I saved last month?" className="flex-1 bg-transparent py-2.5 text-[15px] outline-none placeholder:text-muted-2" />
          <button type="submit" disabled={!q.trim()} className="btn btn-primary !rounded-xl px-4">Ask <ArrowRight size={14} /></button>
        </div>
        <div className="mt-3 flex flex-wrap justify-center gap-1.5">
          {HERO_PROMPTS.map((p) => <button key={p} type="button" onClick={() => go(p)} className="chip hover:border-accent hover:text-accent">{p}</button>)}
        </div>
        <div className="mt-3 text-center text-[11.5px] text-muted">{analyzed.toLocaleString()} of {total.toLocaleString()} saves analyzed and searchable · <Link to="/library" className="underline hover:text-ink">browse the library</Link> · <Link to="/graph" className="underline hover:text-ink">explore the graph</Link></div>
      </form>
    </section>
  );
}

export default function Dashboard() {
  const auth = useAuth();
  const nav = useNavigate();
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => api.get<Stats>('/api/stats'), refetchInterval: 15000 });
  const undig = useQuery({ queryKey: ['resurface'], queryFn: () => api.get<{ date: string; items: ItemLight[] }>('/api/resurface?n=3'), staleTime: 5 * 60_000 });
  const s = stats.data;
  const t = s?.totals;
  const hours = t ? Math.round((t.total_seconds / 3600) * 10) / 10 : 0;
  const greeting = (() => { const h = new Date().getHours(); return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; })();

  if (s && t && t.total === 0) {
    return (
      <div>
        <PageHeader eyebrow={greeting} title={<>Welcome, {auth.username}.</>} subtitle="Let’s dig up your Instagram saves. Import takes about two minutes, then the analysis runs in the background." />
        <Empty icon={<Upload size={28} />} title="Nothing here yet" body="Run the harvester on instagram.com (or upload your Instagram data export) and your whole saved history will get transcribed, summarized and tagged." action={<Link to="/import" className="btn btn-primary">Import your saves <ArrowRight size={14} /></Link>} />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between text-[12.5px] text-muted mb-2 rise">
        <span>{greeting}, {s?.igUsername ? `@${s.igUsername}` : auth.username}{t ? ` · ${t.total.toLocaleString()} saves · ${hours}h of video · ${t.authors} creators` : ''}</span>
        <Link to="/graph" className="btn btn-sm"><Waypoints size={13} /> Graph</Link>
      </div>
      <AskHero total={t?.total ?? 0} analyzed={t?.analyzed ?? 0} />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {t ? (
          <>
            <Stat label="Saves" value={t.total.toLocaleString()} hint={<span className="inline-flex items-center gap-2"><Clapperboard size={11} />{t.videos} <ImageIcon size={11} />{t.images} <Images size={11} />{t.carousels}</span>} />
            <Stat label="Analyzed" value={`${t.total ? Math.round((t.analyzed / t.total) * 100) : 0}%`} hint={`${t.analyzed} done${t.pending ? ` · ${t.pending} pending` : ''}${t.failed ? ` · ${t.failed} failed` : ''}`} accent />
            <Stat label="Transcribed" value={t.transcribed.toLocaleString()} hint={<span className="inline-flex items-center gap-1"><Mic size={11} /> {hours} hours of video in the library</span>} />
            <Stat label="Evergreen" value={t.evergreen.toLocaleString()} hint={<span className="inline-flex items-center gap-2"><Leaf size={11} /> timeless · <Heart size={11} /> {t.favorites} favorites</span>} />
          </>
        ) : Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
      </div>

      {/* Undig today */}
      <section className="mb-8">
        <div className="flex items-end justify-between mb-3">
          <div><div className="eyebrow mb-1">Resurface · today</div><h2 className="display text-[24px]">Three saves worth a second look</h2></div>
          <Link to="/resurface" className="btn btn-sm">More <ArrowRight size={13} /></Link>
        </div>
        {undig.isLoading ? (
          <div className="grid sm:grid-cols-3 gap-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-72" />)}</div>
        ) : undig.data && undig.data.items.length ? (
          <div className="grid sm:grid-cols-3 gap-4">
            {undig.data.items.map((it, i) => (
              <motion.div key={it.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + i * 0.08 }} className="flex flex-col gap-2">
                <ItemCard item={it} index={i} />
                {it.why_today && <div className="flex items-start gap-2 px-1 text-[12.5px] text-ink-2 leading-snug"><Sparkles size={13} className="text-accent shrink-0 mt-0.5" /><span>{it.why_today}</span></div>}
              </motion.div>
            ))}
          </div>
        ) : (
          <div className="card-flat p-6 text-[13px] text-muted">Analysis is still running — resurfacing starts once a few saves are analyzed.</div>
        )}
      </section>

      {/* Breakdown */}
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="card p-5">
          <div className="eyebrow mb-3">Categories</div>
          {s ? <Bars rows={s.categories} onClick={(n) => nav(`/library?category=${encodeURIComponent(n)}`)} max={10} /> : <Skeleton className="h-48" />}
        </div>
        <div className="card p-5">
          <div className="eyebrow mb-3">Top tags</div>
          {s ? (
            <div className="flex flex-wrap gap-1.5">
              {s.tags.slice(0, 40).map((tg) => (
                <button key={tg.name} onClick={() => nav(`/library?tag=${encodeURIComponent(tg.name)}`)} className="chip" style={{ fontSize: `${Math.min(15, 11 + Math.log2(tg.n + 1))}px` }}>{tg.name}<span className="font-mono text-[10px] text-muted">{tg.n}</span></button>
              ))}
              {s.tags.length === 0 && <div className="text-[13px] text-muted">Tags appear once analysis runs.</div>}
            </div>
          ) : <Skeleton className="h-48" />}
        </div>
        <div className="flex flex-col gap-4">
          <div className="card p-5">
            <div className="eyebrow mb-3">Saved over time</div>
            {s ? (s.timeline.length ? <Timeline rows={s.timeline} /> : <div className="text-[13px] text-muted">No dates yet.</div>) : <Skeleton className="h-24" />}
          </div>
          <div className="card p-5">
            <div className="eyebrow mb-3 inline-flex items-center gap-1.5"><Users size={11} /> Most saved creators</div>
            {s ? (
              <div className="space-y-1.5">
                {s.authors.slice(0, 7).map((a) => (
                  <button key={a.name} onClick={() => nav(`/library?author=${encodeURIComponent(a.name)}`)} className="flex w-full items-center justify-between text-[13px] hover:text-accent">
                    <span className="truncate">@{a.name}<span className="text-muted"> {a.full_name ? `· ${a.full_name}` : ''}</span></span><span className="font-mono text-[11px] text-muted">{a.n}</span>
                  </button>
                ))}
              </div>
            ) : <Skeleton className="h-32" />}
          </div>
        </div>
      </div>

      {s && s.contentTypes.length > 0 && (
        <div className="mt-4 card p-5">
          <div className="eyebrow mb-3">Formats you save</div>
          <div className="flex flex-wrap gap-2">
            {s.contentTypes.map((c) => <button key={c.name} onClick={() => nav(`/library?content_type=${encodeURIComponent(c.name)}`)} className="chip">{CONTENT_TYPE_LABEL[c.name] || c.name}<span className="font-mono text-[10px] text-muted">{c.n}</span></button>)}
          </div>
        </div>
      )}
    </div>
  );
}
