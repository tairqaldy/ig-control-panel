/**
 * Screen 5 — Done (ROUND7-SPEC §2). What they can do now in three links, and the trial dates restated so the
 * charge is never a surprise. Leaving through any of them records that setup is finished.
 */
import { Library, MessageSquareText, Sparkles } from 'lucide-react';
import { useAuth, usePlan } from '../../lib/store';
import { fmtDate } from '../../lib/utils';
import { WizardShell, type StepProps } from './WizardShell';
import { useJobs } from './useWizard';

const LINKS: Array<{ to: string; label: string; detail: string; icon: typeof Library }> = [
  { to: '/ask', label: 'Ask a question', detail: 'Plain language, answered from your saves, with links to them.', icon: MessageSquareText },
  { to: '/library', label: 'Browse the library', detail: 'Filter by category, tag or creator. Search inside transcripts.', icon: Library },
  { to: '/resurface', label: 'See today’s three picks', detail: 'Three saves a day, chosen from the useful, evergreen ones.', icon: Sparkles },
];

export function StepDone({ step, onStep, onLeave, finish }: StepProps) {
  const auth = useAuth();
  const plan = usePlan();
  const jobs = useJobs();
  const analyzed = jobs.data?.analyzed ?? 0;
  const total = jobs.data?.total ?? 0;

  /* One calm sentence about money, only when there is one to say. A card-at-signup checkout (ROUND7 §1) leaves the
     tenant on pro/studio straight away with `trialEndsAt` holding Paddle's first-charge date, so the free days are
     read off that date rather than off the old card-less `trial` plan. */
  const freeUntil = plan?.trialEndsAt && plan.trialEndsAt * 1000 > Date.now() ? plan.trialEndsAt : null;
  let planLine: string | null = null;
  if (auth.hosted && plan) {
    if (plan.effectivePlan === 'free' && plan.plan === 'trial') planLine = 'Your free days are over. The library stays readable and exportable; see the plans in Billing.';
    else if (freeUntil && plan.plan === 'trial') planLine = `Free until ${fmtDate(freeUntil)}. Nothing is charged before then — you pick a plan when it ends.`;
    else if (freeUntil) planLine = `Nothing is charged until ${fmtDate(freeUntil)}. Cancel any time in Billing — one click, no e-mail.`;
    else if (plan.renewsAt && plan.status === 'active') planLine = `Your plan renews on ${fmtDate(plan.renewsAt)}. Cancel any time in Billing — one click, no e-mail.`;
  }

  return (
    <WizardShell
      step={step} onStep={onStep} onLeave={onLeave}
      title="That’s the setup done"
      body={!jobs.data
        ? 'Here is where to go next.'
        : total > 0
          ? `${analyzed.toLocaleString()} of ${total.toLocaleString()} saves have a note so far. The rest keep going in the background.`
          : 'Your saves can come in whenever you like — the Import page has both ways.'}
      primary={{ label: 'Go to my overview', onClick: () => finish('/') }}
      footNote={planLine ?? undefined}
    >
      <ul className="space-y-2.5">
        {LINKS.map(({ to, label, detail, icon: Icon }) => (
          <li key={to}>
            <button onClick={() => finish(to)} className="card flex w-full items-start gap-3 p-4 text-left transition-colors hover:border-accent">
              <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent"><Icon size={16} /></span>
              <span className="min-w-0">
                <span className="block text-[14.5px] font-medium text-ink">{label}</span>
                <span className="mt-0.5 block text-[13px] leading-relaxed text-muted">{detail}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {!!jobs.data && total === 0 && (
        <button onClick={() => onStep(1)} className="mt-3 text-[13px] text-muted underline decoration-line-2 underline-offset-4 hover:text-ink">Go back and bring my saves in</button>
      )}
    </WizardShell>
  );
}
