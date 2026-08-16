import { motion } from 'motion/react';
import { Sparkles, MessageSquareText, Clapperboard, PieChart, BarChart3, Lightbulb, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import type { AskIntent, AskSuggestion } from '../../lib/types-ask';
import { Skeleton } from '../ui';

const ICON: Record<AskIntent, LucideIcon> = { library: MessageSquareText, create: Clapperboard, stats: PieChart, analytics: BarChart3, inspire: Lightbulb, chat: Sparkles, guide: Sparkles };

/** Fallback when /api/ask/suggestions is unavailable or empty. Written the way people actually type. */
export const FALLBACK_SUGGESTIONS: AskSuggestion[] = [
  { text: 'What are the recurring themes across everything I saved?', intent: 'stats' },
  { text: 'What hooks do the reels I saved use? Give me examples', intent: 'library' },
  { text: 'Which tools and apps did I save the most, and what were they for?', intent: 'library' },
  { text: 'Content brief: a reel based on the productivity advice I keep saving', intent: 'create' },
  { text: 'What recipes did I save? List the ingredients where you can', intent: 'library' },
  { text: 'Give me 3 ideas for this week from my evergreen saves', intent: 'inspire' },
];

/**
 * Empty thread: one headline, one sentence, six suggestion cards, and a single quiet legend line.
 * The page header already says "Ask", so no eyebrow here. `hasLibrary=false` explains what to do first instead of showing cards.
 */
export function EmptyState({ suggestions, loading, onPick, username, total, hasLibrary }: { suggestions: AskSuggestion[]; loading: boolean; onPick: (s: AskSuggestion) => void; username?: string | null; total?: number | null; hasLibrary: boolean }) {
  const list = (suggestions.length ? suggestions : FALLBACK_SUGGESTIONS).slice(0, 6);
  return (
    <div className="mx-auto w-full max-w-3xl px-1 pt-2 sm:pt-6">
      <div className="mb-6 text-center">
        <h1 className="display text-[32px] leading-[1.04] tracking-tight sm:text-[44px]">
          {hasLibrary ? <>Ask it like you’d ask a friend<br className="hidden sm:block" /> who watched every reel you saved.</> : <>Nothing to ask yet — <br className="hidden sm:block" />Ask wakes up after your first saves arrive.</>}
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-[14px] leading-relaxed text-muted">
          {hasLibrary
            ? <>Answers come only from your {total ? total.toLocaleString() : ''} saves and cite the exact ones{username ? `, @${username}` : ''}. Ask about a topic, ask what you tend to save, or ask for a content brief built from what you already liked.</>
            : <>Bring your saves in, wait for the first notes, then come back — every answer is built only from what is in your library, with citations you can open.</>}
        </p>
        {!hasLibrary && <Link to="/import" className="btn btn-primary mt-4">Bring your saves</Link>}
      </div>
      {hasLibrary && (loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((s, i) => {
            const Icon = ICON[s.intent || 'library'] || Sparkles;
            return (
              <motion.button key={s.text} type="button" onClick={() => onPick(s)} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.04 * i, duration: 0.3, ease: [0.2, 0.7, 0.2, 1] }} className="card group flex flex-col p-4 text-left text-[13.5px] leading-snug transition-all hover:-translate-y-0.5 hover:border-line-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <Icon size={14} className="mb-2 text-accent" />
                <span className="text-ink">{s.text}</span>
                {s.hint && <span className="mt-1.5 text-[11.5px] text-muted">{s.hint}</span>}
              </motion.button>
            );
          })}
        </div>
      ))}
      {hasLibrary && (
        <p className="mt-5 text-center text-[12px] leading-relaxed text-muted">
          Citations appear as <span className="cite !cursor-default !mx-0.5">#1</span> chips — click to open the save, hover for a preview. The chips above the box switch modes: a content brief, your taste in numbers, or your Instagram analytics.
        </p>
      )}
    </div>
  );
}
