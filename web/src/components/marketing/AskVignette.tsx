/* Ask vignette: a small dark replica of the Ask composer + answer that types a question and streams an answer.
   The answer is built only from web/public/landing/saves.json (Mino Lee's five-step storytelling framework) —
   the same save shown in "What a save turns into" — so nothing on the page is invented. Loops while in view. */
import { useRef } from 'react';
import { useInView, useReducedMotion } from 'motion/react';
import { ArrowUp, Sparkles } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useTimeline, typed, streamed } from './hooks';

const QUESTION = 'What did I save about hooks for short videos?';
const SOURCES = ['Five-step storytelling framework for viral videos', 'Psychology-based hooks for stronger creator content'];
const ANSWER_1 = 'The most direct one is Mino Lee’s five-step framework';
const ANSWER_2 = ': the hook states a specific goal and a conflict, a “click confirmation” shows progress toward it, a second setback lands halfway, then the climax and an earned resolution. He credits the structure with 50 million views.';

const T_TYPE = 400, T_SEND = 2000, T_SOURCES = 2500, T_STREAM = 3000, LOOP = 12500;

export function AskVignette({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.5 });
  const reduced = !!useReducedMotion();
  const t = useTimeline(inView, LOOP, { reduced });
  const q = typed(QUESTION, t, T_TYPE, 30);
  const sent = t >= T_SEND;
  const a1 = streamed(ANSWER_1, t, T_STREAM, 12);
  const a1done = a1.length >= ANSWER_1.length;
  const a2 = a1done ? streamed(ANSWER_2, t, T_STREAM + (ANSWER_1.split(' ').length / 12) * 1000, 12) : '';
  const streaming = t >= T_STREAM && a2.length < ANSWER_2.length;

  return (
    <div ref={ref} className={cn('mk-dark card p-4 text-[13px] leading-relaxed', className)} aria-label="Ask: a question typed, an answer streamed with a citation">
      <div className="flex items-center justify-between mb-3">
        <div className="eyebrow">Ask</div>
        <div className="font-mono text-[10.5px] text-muted tabular">19 / 20 questions</div>
      </div>
      {/* composer */}
      <div className={cn('flex items-center gap-2 rounded-xl border bg-surface px-3 py-2 min-h-[38px] transition-colors', sent ? 'border-line' : 'border-accent/60')}>
        <span className={cn('flex-1 truncate', q ? 'text-ink' : 'text-muted-2', !sent && q.length < QUESTION.length && 'mk-caret')}>{q || (t < T_TYPE ? 'Ask your saves…' : '')}</span>
        <span className={cn('h-6 w-6 grid place-items-center rounded-lg transition-colors', q.length >= QUESTION.length ? 'bg-accent text-accent-ink' : 'bg-surface-2 text-muted-2')}><ArrowUp size={13} /></span>
      </div>
      {/* sources */}
      <div className={cn('mt-3 transition-opacity duration-500', t >= T_SOURCES ? 'opacity-100' : 'opacity-0')} aria-hidden={t < T_SOURCES}>
        <div className="eyebrow mb-1.5">Sources · {SOURCES.length}</div>
        <div className="flex gap-1.5 min-w-0">
          {SOURCES.map((s, i) => (
            <span key={s} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 py-1 pl-1 pr-2 min-w-0 max-w-[220px]"><span className="cite !cursor-default !mx-0 shrink-0">#{i + 1}</span><span className="text-[11.5px] truncate">{s}</span></span>
          ))}
        </div>
      </div>
      {/* answer */}
      <div className={cn('mt-3 rounded-xl border border-line bg-surface-2 px-3.5 py-3 min-h-[122px] sm:min-h-[104px] transition-opacity duration-300', t >= T_STREAM - 300 ? 'opacity-100' : 'opacity-0')} aria-live="polite">
        {t < T_STREAM ? (
          <span className="inline-flex items-center gap-2 text-muted"><span className="h-1.5 w-1.5 rounded-full bg-accent pulse-dot" /> Reading 2 saves…</span>
        ) : (
          <p className={cn('text-ink-2', streaming && 'mk-caret')}>
            {a1}{a1done && <span className="cite !cursor-default">#1</span>}{a2}
          </p>
        )}
      </div>
      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-muted"><Sparkles size={11} className="text-accent" /> Answers come only from your saves. Click a citation to open the save.</div>
    </div>
  );
}
