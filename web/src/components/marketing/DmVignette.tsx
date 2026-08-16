/* DM automation vignette: a comment arrives → the "comment keyword → DM" starter rule matches → the reply types
   itself into a DM → a check. Dark product UI, loops while in view, reduced motion shows the finished state. */
import { useRef } from 'react';
import { useInView, useReducedMotion } from 'motion/react';
import { Check, MessageCircle, Send, Zap } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useTimeline, typed } from './hooks';

const KEYWORDS = ['link', 'send', 'guide'];
const COMMENT = 'link please';
const REPLY = 'Hey maria.builds — here’s the link you asked for: yoursite.com/guide';
const T_COMMENT = 500, T_MATCH = 1500, T_REPLY = 2300, T_SENT = 2300 + (REPLY.length / 34) * 1000 + 500, LOOP = 10500;

export function DmVignette({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.5 });
  const reduced = !!useReducedMotion();
  const t = useTimeline(inView, LOOP, { reduced });
  const reply = typed(REPLY, t, T_REPLY, 34);
  const sent = t >= T_SENT;

  return (
    <div ref={ref} role="img" className={cn('mk-dark card p-4 text-[13px]', className)} aria-label="Automation: a comment with the word link gets an automatic direct message with the link">
      {/* the rule */}
      <div className="flex items-center gap-2.5 rounded-xl border border-line bg-surface-2 px-3 py-2">
        <span className="h-7 w-7 grid place-items-center rounded-lg bg-accent-soft text-accent shrink-0"><Zap size={13} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium truncate">Comment keyword → DM the link</div>
          <div className="mt-0.5 flex items-center gap-1 flex-wrap">{KEYWORDS.map((k) => <span key={k} className={cn('font-mono text-[10px] rounded px-1 py-px border', k === 'link' && t >= T_MATCH ? 'border-accent text-accent bg-accent-soft' : 'border-line text-muted')}>{k}</span>)}</div>
        </div>
        <span className="relative inline-block h-4 w-7 rounded-full bg-accent shrink-0" aria-label="Enabled"><span className="absolute top-0.5 left-[14px] h-3 w-3 rounded-full bg-accent-ink" /></span>
      </div>

      <div className="mt-3 space-y-2.5 min-h-[168px]">
        {/* comment */}
        <div className={cn('flex items-start gap-2 transition-all duration-500', t >= T_COMMENT ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2')} aria-hidden={t < T_COMMENT}>
          <span className="h-7 w-7 rounded-full bg-[oklch(0.62_0.12_28)] text-white grid place-items-center text-[11px] font-semibold shrink-0">M</span>
          <div className="min-w-0">
            <div className="text-[11px] text-muted flex items-center gap-1.5"><MessageCircle size={11} /> maria.builds commented on your reel</div>
            <div className="mt-1 inline-block rounded-2xl rounded-tl-md border border-line bg-surface px-3 py-1.5 text-ink">{COMMENT}</div>
          </div>
        </div>
        {/* match */}
        <div className={cn('pl-9 text-[11px] font-mono text-accent transition-opacity duration-300', t >= T_MATCH ? 'opacity-100' : 'opacity-0')} aria-hidden={t < T_MATCH}>matched “link” · rule 1</div>
        {/* reply */}
        <div className={cn('flex justify-end transition-opacity duration-300', t >= T_REPLY ? 'opacity-100' : 'opacity-0')} aria-hidden={t < T_REPLY}>
          <div className="max-w-[88%]">
            <div className="text-[11px] text-muted text-right flex items-center justify-end gap-1.5"><Send size={11} /> Direct message</div>
            <div className={cn('mt-1 rounded-2xl rounded-br-md bg-ink text-bg px-3 py-1.5 leading-relaxed', !sent && 'mk-caret')}>{reply}</div>
            <div className={cn('mt-1 text-right text-[11px] font-mono flex items-center justify-end gap-1 transition-opacity duration-300', sent ? 'opacity-100 text-accent' : 'opacity-0')}><Check size={11} /> sent · 0.8 s</div>
          </div>
        </div>
      </div>
    </div>
  );
}
