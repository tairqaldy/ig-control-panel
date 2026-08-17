/**
 * /welcome — the linear onboarding wizard (ROUND7-SPEC §2). Five screens, one at a time, one primary action each:
 *
 *   1. Bring your saves in   — install the Companion (waits and detects the pairing) or upload an Instagram export
 *   2. Watch it work         — live count and the first three real notes from their own library
 *   3. Ask your first question — three ready-made questions, answered inline
 *   4. Instagram             — only offers Connect when §3's availability endpoint says it can actually work
 *   5. Done                  — what they can do now, three links, and the trial dates restated
 *
 * The screen lives in `?step=N` (reload- and Back-safe) and the furthest one reached is kept server-side in the
 * onboarding meta keys (`welcome_seen`, `welcome_step`, `welcome_done`), so starting on a phone does not restart the
 * wizard on a laptop.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import type { WelcomeStep } from '../lib/types-onboarding';
import { markWelcomeDone, useOnboardingEvent } from '../components/Onboarding';
// Imported file-by-file on purpose: a bare '../components/onboarding' resolves to components/Onboarding.tsx on a
// case-insensitive filesystem and to the folder on Linux, so the folder never gets a barrel file.
import { useWizardStep } from '../components/onboarding/useWizard';
import { StepBringSaves } from '../components/onboarding/StepBringSaves';
import { StepWatchItWork } from '../components/onboarding/StepWatchItWork';
import { StepFirstQuestion } from '../components/onboarding/StepFirstQuestion';
import { StepInstagram } from '../components/onboarding/StepInstagram';
import { StepDone } from '../components/onboarding/StepDone';

export default function Welcome() {
  const { step, go } = useWizardStep();
  const nav = useNavigate();
  const ev = useOnboardingEvent();

  const seen = useRef(false);
  useEffect(() => {
    if (seen.current) return;
    seen.current = true;
    ev.mutate('welcome_seen');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const next = useCallback(() => go(Math.min(5, step + 1) as WelcomeStep), [go, step]);
  const onLeave = useCallback(() => nav('/'), [nav]);
  const finish = useCallback((to: string) => {
    markWelcomeDone();
    ev.mutate('welcome_done');
    nav(to);
  }, [ev, nav]);

  const props = { step, onStep: go, onLeave, next, finish };
  return (
    <>
      {step === 1 && <StepBringSaves {...props} />}
      {step === 2 && <StepWatchItWork {...props} />}
      {step === 3 && <StepFirstQuestion {...props} />}
      {step === 4 && <StepInstagram {...props} />}
      {step === 5 && <StepDone {...props} />}
    </>
  );
}
