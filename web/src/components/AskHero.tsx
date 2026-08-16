import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ArrowRight, MessageSquareText } from 'lucide-react';
import { api } from '../lib/api';
import type { Stats } from '../lib/types';
import { FALLBACK_SUGGESTIONS, useAskSuggestions } from './Onboarding';

/**
 * Big centered composer: the first thing you see on the Overview. Submitting hands the question to /ask (`/ask?q=…`).
 * `compact` drops the headline/eyebrow and the footer line so it fits inside a card or a narrow column.
 * The prompt chips come from GET /api/ask/suggestions (built from the tenant's real categories/creators), with a static fallback.
 * The "N of M saves analyzed" line comes from the shared `['stats']` query (already cached by the Overview).
 */
export function AskHero({ compact }: { compact?: boolean }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => api.get<Stats>('/api/stats'), staleTime: 15000 });
  const sug = useAskSuggestions();
  const total = stats.data?.totals.total ?? 0;
  const analyzed = stats.data?.totals.analyzed ?? 0;
  const prompts = (sug.data && sug.data.length ? sug.data : FALLBACK_SUGGESTIONS).slice(0, compact ? 3 : 5);
  const go = (question: string) => { const t = question.trim(); if (t) nav(`/ask?q=${encodeURIComponent(t)}`); };
  return (
    <section className={compact ? 'relative rise' : 'relative mb-8 rise'}>
      {!compact && (
        <div className="mx-auto max-w-3xl text-center pt-2 pb-5 sm:pt-4 sm:pb-6">
          <div className="eyebrow mb-3">Ask your saves</div>
          <h1 className="display text-[36px] sm:text-[52px] leading-[1.02] tracking-tight">What did you save about…</h1>
          <p className="mt-3 text-[14.5px] text-muted max-w-xl mx-auto">Ask in plain language. The answer is built only from your saves — transcripts included — and cites the exact ones.</p>
        </div>
      )}
      <form onSubmit={(e) => { e.preventDefault(); go(q); }} className="mx-auto max-w-2xl" role="search" aria-label="Ask your saves">
        <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface p-2 pl-4 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/10 transition-all" style={{ boxShadow: 'var(--shadow-lg)' }}>
          <MessageSquareText size={18} className="text-muted shrink-0" />
          <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus={!compact} placeholder="e.g. what were the cold-email tips I saved last month?" aria-label="Your question" className="min-w-0 flex-1 bg-transparent py-2.5 text-[15px] outline-none placeholder:text-muted-2" />
          <button type="submit" disabled={!q.trim()} className="btn btn-primary !rounded-xl px-4">Ask <ArrowRight size={14} /></button>
        </div>
        <div className={compact ? 'mt-2.5 flex flex-wrap gap-1.5' : 'mt-3 flex flex-wrap justify-center gap-1.5'}>
          {prompts.map((p) => <button key={p} type="button" onClick={() => go(p)} className="chip max-w-full !whitespace-normal !leading-snug text-left hover:border-accent hover:text-accent">{p}</button>)}
        </div>
        {!compact && (
          <div className="mt-3 text-center text-[11.5px] text-muted">{analyzed.toLocaleString()} of {total.toLocaleString()} saves analyzed and searchable · <Link to="/library" className="underline hover:text-ink">browse the library</Link> · <Link to="/graph" className="underline hover:text-ink">explore the graph</Link></div>
        )}
      </form>
    </section>
  );
}

export default AskHero;
