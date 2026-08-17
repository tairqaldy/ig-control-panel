/**
 * Screen 3 — Ask your first question (ROUND7-SPEC §2). Three ready-made questions built from the person's real
 * library (`/api/ask/suggestions`); tapping one runs it right here, streaming, with the citations clickable.
 * No empty text box: the first thing a distracted person sees is three things they can tap.
 */
import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, MessageSquareText, PauseCircle } from 'lucide-react';
import { streamAsk } from '../../lib/ask';
import type { AskSource } from '../../lib/types';
import { useItemModal } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Answer } from '../ask/Answer';
import { useAskSuggestions, useOnboardingEvent } from '../Onboarding';
import { WizardShell, type StepProps } from './WizardShell';
import { useJobs } from './useWizard';

export function StepFirstQuestion({ step, onStep, onLeave, next }: StepProps) {
  const jobs = useJobs();
  const suggestions = useAskSuggestions();
  const modal = useItemModal();
  const ev = useOnboardingEvent();
  const analyzed = jobs.data?.analyzed ?? 0;

  const [question, setQuestion] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sources, setSources] = useState<AskSource[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);

  const prompts = (suggestions.data ?? []).slice(0, 3);

  const run = (q: string) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setQuestion(q); setText(''); setSources([]); setError(null); setStreaming(true);
    ev.mutate('asked');
    void streamAsk({ question: q }, {
      signal: c.signal,
      onDelta: (d) => setText((t) => t + d),
      onSources: (s) => setSources(s),
      onError: (m) => setError(m),
    }).then((r) => {
      if (r.aborted) return;
      setStreaming(false);
      if (r.error) setError(r.error);
    });
  };

  /* ---------------- the model itself is unavailable ----------------
     Offering three questions that all fail is exactly the trap this round exists to remove: no key on the server, or
     an OpenAI account out of credit, means Ask answers nothing. Say so once and move them to what does work. */
  const w = jobs.data;
  const noOpenAI = !!w && !w.openaiConfigured;
  const noCredit = !!w?.paused && w.pauseReason === 'quota';
  if (w && (noOpenAI || noCredit)) {
    return (
      <WizardShell
        step={step} onStep={onStep} onLeave={onLeave}
        title="Questions are paused"
        body={noOpenAI
          ? 'The AI service is not set up on this server yet, so questions cannot be answered. Your saves are safe.'
          : 'The AI service is out of credit right now, so questions cannot be answered. Your saves are safe.'}
        primary={{ label: 'See what I can do now', onClick: next }}
      >
        <div className="card flex items-start gap-3 p-4 text-[13.5px]">
          <PauseCircle size={17} className="mt-0.5 shrink-0 text-muted" />
          <span className="text-ink-2">Your library is still there: search it by caption, creator or collection. Notes and answers appear once the service is back — nothing has to be re-imported.</span>
        </div>
      </WizardShell>
    );
  }

  /* ---------------- nothing to answer from (only once we actually know) ---------------- */
  if (jobs.data && analyzed === 0) {
    return (
      <WizardShell
        step={step} onStep={onStep} onLeave={onLeave}
        title="Nothing to answer from yet"
        body="Questions are answered out of your own saves, and none of them have been analyzed yet."
        primary={{ label: 'Back to the analysis', onClick: () => onStep(2) }}
        later={{ label: 'Carry on without asking', onClick: next }}
      />
    );
  }

  const answered = !!question && (!!text || !!error) && !streaming;

  return (
    <WizardShell
      step={step} onStep={onStep} onLeave={onLeave}
      title={question ? question : 'Ask your first question'}
      body={question ? undefined : 'Tap one. The answer is built only from your own saves and links to the exact ones.'}
      primary={answered ? { label: 'That’s it — what can I do now', onClick: next } : undefined}
      later={{ label: question ? 'Move on to the next step' : 'I’ll ask something later', onClick: next }}
    >
      {!question && (
        <ul className="space-y-2.5">
          {(suggestions.isLoading ? ['', '', ''] : prompts).map((p, i) => (
            <li key={p || i}>
              <motion.button
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                onClick={() => p && run(p)} disabled={!p}
                className={cn('card flex w-full items-start gap-3 p-4 text-left transition-colors hover:border-accent', !p && 'animate-pulse')}
              >
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent"><MessageSquareText size={15} /></span>
                <span className="text-[14.5px] leading-snug text-ink">{p || 'Loading a question from your library…'}</span>
              </motion.button>
            </li>
          ))}
        </ul>
      )}

      {question && (
        <div className="card p-4 sm:p-5">
          {error ? (
            <div className="flex items-start gap-2.5 text-[13.5px]">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
              <div>
                <div className="text-ink-2">{error}</div>
                <button onClick={() => { setQuestion(null); setError(null); }} className="btn btn-sm mt-3">Try a different question</button>
              </div>
            </div>
          ) : (
            <>
              <Answer text={text || 'Reading your saves…'} sources={sources} streaming={streaming} onCite={(id) => modal.open(id)} />
              {answered && prompts.length > 1 && (
                <div className="mt-4 border-t border-line pt-3">
                  <div className="eyebrow mb-2">Another one</div>
                  <div className="flex flex-wrap gap-1.5">
                    {prompts.filter((p) => p !== question).map((p) => (
                      <button key={p} onClick={() => run(p)} className="chip max-w-full !whitespace-normal !leading-snug text-left hover:border-accent hover:text-accent">{p}</button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </WizardShell>
  );
}
