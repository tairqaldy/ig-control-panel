/* Five taps, one question per card, every answer prefilled from what we already know.
   Tapping an option is the answer *and* the next step — the person confirms rather than composes. */
import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { EMPTY_GOALS, GOAL_KEYS, type GoalKey, type ProfileGoals, type ProfileQuestion } from '../../lib/types-profile';
import { cn } from '../../lib/utils';

/** Answers keyed by question id; the five `profile_goals` columns are picked out of it on submit. */
export type Answers = Record<string, string>;

export function answersToGoals(answers: Answers): ProfileGoals {
  const g: ProfileGoals = { ...EMPTY_GOALS };
  for (const k of GOAL_KEYS) { const v = (answers[k] || '').trim(); if (v) g[k as GoalKey] = v; }
  return g;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const matches = (q: ProfileQuestion, v: string) => q.options.some((o) => same(o.value, v) || same(o.label, v));

export function Questionnaire({ questions, onDone, onCancel, busy, submitLabel = 'Score my profile' }: {
  questions: ProfileQuestion[];
  onDone: (answers: Answers) => void;
  onCancel?: () => void;
  busy?: boolean;
  submitLabel?: string;
}) {
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<Answers>(() => Object.fromEntries(questions.map((q) => [q.id, q.prefill ?? ''])));
  const q = questions[i];
  const total = questions.length;
  const answer = q ? answers[q.id] ?? '' : '';
  const chosen = useMemo(() => (q ? q.options.find((o) => same(o.value, answer) || same(o.label, answer)) ?? null : null), [q, answer]);
  const [other, setOther] = useState<string>(() => (q && answer && !matches(q, answer) ? answer : ''));

  if (!q) return null;
  const last = i === total - 1;

  const goTo = (n: number, from: Answers) => {
    const nq = questions[n]; const na = from[nq.id] ?? '';
    setOther(na && !matches(nq, na) ? na : '');
    setI(n);
  };
  const commit = (value: string, advance: boolean) => {
    const next = { ...answers, [q.id]: value };
    setAnswers(next);
    if (!advance) return;
    if (last) onDone(next);
    else goTo(i + 1, next);
  };
  const back = () => { if (i === 0) onCancel?.(); else goTo(i - 1, answers); };

  return (
    <div className="mx-auto w-full max-w-xl">
      <div className="mb-5 flex items-center gap-3">
        <button type="button" onClick={back} className="btn btn-ghost btn-sm !px-1.5 text-muted" aria-label={i === 0 ? 'Close the questionnaire' : 'Previous question'}><ArrowLeft size={15} /></button>
        <div className="flex flex-1 items-center gap-1.5" role="progressbar" aria-valuenow={i + 1} aria-valuemin={1} aria-valuemax={total} aria-label={`Question ${i + 1} of ${total}`}>
          {questions.map((qq, n) => <span key={qq.id} className={cn('h-1.5 flex-1 rounded-full transition-colors', n < i ? 'bg-accent' : n === i ? 'bg-accent/60' : 'bg-line')} />)}
        </div>
        <span className="font-mono text-[11.5px] tabular text-muted">{i + 1}/{total}</span>
      </div>

      {/* Keyed, and deliberately without AnimatePresence: an exit animation leaves the finished card on
          screen — and clickable — while the next one waits, which is the confusion this wizard exists to avoid. */}
      <motion.div key={q.id} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.16 }} className="card p-5 sm:p-6">
        <h2 className="display text-[24px] leading-tight text-ink">{q.title}</h2>
        {q.help && <p className="mt-1.5 text-[13px] text-muted leading-relaxed">{q.help}</p>}
        {q.prefillFrom && !q.answered && <p className="mt-1.5 text-[12px] text-accent">Suggested from {q.prefillFrom}.</p>}

        {q.options.length > 0 && (
          <div className="mt-5 flex flex-col gap-2">
            {q.options.map((o) => {
              const on = chosen?.value === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => { setOther(''); commit(o.value, true); }}
                  className={cn('flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors', on ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-line-2 hover:bg-surface-2/60')}
                >
                  <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full border', on ? 'border-accent bg-accent text-accent-ink' : 'border-line-2')}>{on && <Check size={12} />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] text-ink">{o.label}</span>
                    {o.hint && <span className="block text-[12px] text-muted">{o.hint}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {(q.allowOther || q.options.length === 0) && (
          <div className="mt-4">
            {q.options.length > 0 && <div className="eyebrow mb-1.5">{q.otherLabel ?? 'Or say it yourself'}</div>}
            {/* Enter does what the primary button does — an empty box must not wipe the option they just tapped. */}
            <input
              className="input"
              value={other}
              placeholder={q.placeholder ?? 'Type your answer'}
              onChange={(e) => { setOther(e.target.value); setAnswers((a) => ({ ...a, [q.id]: e.target.value })); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit((other.trim() || answer).trim(), true); } }}
              aria-label={q.title}
            />
          </div>
        )}

        <div className="mt-5 flex items-center justify-between gap-3">
          <button type="button" onClick={() => commit('', true)} className="text-[12.5px] text-muted hover:text-ink transition-colors">Skip this one</button>
          <button type="button" onClick={() => commit((other.trim() || answer).trim(), true)} disabled={busy} className="btn btn-primary">
            {last ? (busy ? 'Working…' : submitLabel) : 'Next'} <ArrowRight size={13} />
          </button>
        </div>
      </motion.div>

      <p className="mt-3 text-center text-[12px] text-muted">Answers are saved. Next time you only confirm them.</p>
    </div>
  );
}
