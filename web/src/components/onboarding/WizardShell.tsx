/**
 * The frame every /welcome screen is poured into (ROUND7-SPEC §2): a 5-dot rail, Back, one big primary button,
 * and "I'll do this later" as quiet text underneath — never a second button competing with the primary one.
 *
 * Mobile is the primary layout: the column fills the viewport and the action bar sticks to the bottom of the
 * screen, inside thumb reach, above the home indicator.
 */
import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react';
import type { WelcomeStep } from '../../lib/types-onboarding';
import { WELCOME_STEPS } from '../../lib/types-onboarding';
import { cn } from '../../lib/utils';
import { WELCOME_STEP_LABELS } from './useWizard';

export interface WizardAction {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
}

export function WizardShell({ step, onStep, onLeave, back, title, body, children, primary, secondary, later, footNote }: {
  step: WelcomeStep;
  onStep: (s: WelcomeStep) => void;
  /** Back on screen 1 leaves setup for the app — Back is never a dead end. */
  onLeave: () => void;
  /**
   * What Back should do instead, when a screen has state of its own to step out of. Screen 1 uses it: having chosen
   * "Companion" and found you need a computer, the button labelled Back has to return to the two choices, not drop
   * you on the dashboard with the choice silently remembered.
   */
  back?: () => void;
  title: ReactNode;
  /** one or two calm sentences; the spec's budget is ~25 words */
  body?: ReactNode;
  children?: ReactNode;
  /** omitted only when the screen's own content *is* the obvious action (screen 3's three questions) */
  primary?: WizardAction;
  /** a real alternative route through this screen, styled below the primary, not beside it */
  secondary?: WizardAction;
  /** quiet text: skipping this screen */
  later?: { label: string; onClick: () => void };
  footNote?: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col min-h-[calc(100svh-8.5rem)] lg:min-h-[calc(100svh-6rem)]">
      {/* rail */}
      <div className="flex items-center gap-3 mb-5">
        <button
          onClick={() => (back ? back() : step > 1 ? onStep((step - 1) as WelcomeStep) : onLeave())}
          className="btn btn-ghost btn-sm !px-2 text-muted"
          aria-label={back ? 'Back' : step > 1 ? `Back to step ${step - 1}` : 'Leave setup'}
          title={back ? 'Back' : step > 1 ? WELCOME_STEP_LABELS[(step - 1) as WelcomeStep] : 'Leave setup and open the app'}
        >
          <ArrowLeft size={16} /> <span className="text-[12.5px]">Back</span>
        </button>
        <ol className="flex items-center gap-1.5" aria-label={`Step ${step} of 5`}>
          {WELCOME_STEPS.map((n) => (
            <li key={n}>
              <button
                onClick={() => n < step && onStep(n)}
                disabled={n >= step}
                aria-current={n === step ? 'step' : undefined}
                aria-label={`Step ${n}: ${WELCOME_STEP_LABELS[n]}`}
                title={WELCOME_STEP_LABELS[n]}
                className={cn('block h-2 rounded-full transition-all disabled:cursor-default', n === step ? 'w-7 bg-accent' : n < step ? 'w-2.5 bg-accent/50 cursor-pointer' : 'w-2.5 bg-line-2')}
              />
            </li>
          ))}
        </ol>
        <span className="ml-auto font-mono text-[11px] uppercase tracking-[0.12em] text-muted tabular">Step {step} of 5</span>
      </div>

      {/* screen */}
      <div className="flex-1">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}>
          <h1 className="display text-[30px] sm:text-[40px] leading-[1.05] tracking-tight text-balance">{title}</h1>
          {body && <p className="mt-2.5 text-[14.5px] sm:text-[15px] text-ink-2 leading-relaxed max-w-xl">{body}</p>}
          {children && <div className="mt-6">{children}</div>}
        </motion.div>
      </div>

      {/* action bar — sticks to the bottom of the phone screen, full-width thumb target */}
      <div className="sticky bottom-0 z-10 -mx-4 mt-8 border-t border-line bg-bg/92 px-4 pt-3 pb-[max(0.85rem,env(safe-area-inset-bottom))] backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:pb-0 sm:backdrop-blur-none">
        {primary && (
          <button
            onClick={primary.onClick}
            disabled={primary.disabled || primary.busy}
            className="btn btn-primary w-full justify-center !py-3 !text-[15px] sm:w-auto sm:!px-6"
          >
            {primary.busy ? <Loader2 size={16} className="animate-spin" /> : primary.icon ?? null}
            {primary.label}
            {!primary.busy && !primary.icon && <ArrowRight size={15} />}
          </button>
        )}
        {secondary && (
          <button onClick={secondary.onClick} disabled={secondary.disabled || secondary.busy} className={cn('btn mt-2 w-full justify-center !py-2.5 sm:mt-0 sm:w-auto', primary && 'sm:ml-2')}>
            {secondary.busy ? <Loader2 size={15} className="animate-spin" /> : secondary.icon ?? null}
            {secondary.label}
          </button>
        )}
        {later && (
          <div className="mt-2.5 text-center sm:text-left">
            <button onClick={later.onClick} className="text-[13px] text-muted underline decoration-line-2 underline-offset-4 hover:text-ink">{later.label}</button>
          </div>
        )}
        {footNote && <div className="mt-2 text-[12px] text-muted leading-relaxed">{footNote}</div>}
      </div>
    </div>
  );
}

/** What every screen gets: where it is, and the ways out (any step, the next step, out of setup for good). */
export interface StepProps {
  step: WelcomeStep;
  onStep: (s: WelcomeStep) => void;
  /** leave setup without finishing it — the checklist keeps the remaining steps */
  onLeave: () => void;
  next: () => void;
  /** setup is done: records it server-side and opens `to` */
  finish: (to: string) => void;
}
