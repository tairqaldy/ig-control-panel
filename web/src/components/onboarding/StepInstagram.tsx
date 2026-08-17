/**
 * Screen 4 — Instagram, optional and honest (ROUND7-SPEC §2, availability contract from §3).
 *
 * The founder's father was told to connect Instagram over and over while a platform gate made it impossible. So this
 * screen asks `GET /api/instagram/availability` first and only shows a Connect button when the answer is yes. When it
 * is no it says why, in one sentence, and offers to record that he wants to know when it opens.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { BellRing, Check, Mail, TriangleAlert } from 'lucide-react';
import type { IgWaitlistFailure } from '../../lib/types-onboarding';
import { useAuth } from '../../lib/store';
import { InstagramGlyph } from '../instagram/icons';
import { startInstagramConnect } from '../instagram/useIgAccount';
import { WizardShell, type StepProps } from './WizardShell';
import { useIgAvailability, useIgWaitlist } from './useWizard';

const SUPPORT_EMAIL = 'hello@resurfly.com';

/** Where Meta sends the browser back to. The server signs it into the OAuth state, so both outcomes land here. */
const RETURN_TO = '/welcome?step=4';

/** Meta's own refusal codes, in the words of somebody who did not cause them. */
const OAUTH_ERROR: Record<string, string> = {
  denied: 'You declined the permissions on Instagram, so nothing was connected. Everything else here still works.',
  unavailable: 'Instagram connections are not open for this account yet, so we did not send you on to Meta.',
  state: 'That connect link had expired. Nothing changed — start it again if you want to.',
};

export function StepInstagram({ step, onStep, onLeave, next }: StepProps) {
  const auth = useAuth();
  const q = useIgAvailability();
  const waitlist = useIgWaitlist();
  const [failure, setFailure] = useState<IgWaitlistFailure | null>(null);
  const [sp] = useSearchParams();
  /* Came back from Meta. Round 7: the OAuth round trip returns to this screen, so this screen has to say what
     happened — it used to send people to /automations, from where /welcome was unreachable with a full library. */
  const oauthError = sp.get('error');
  const errorLine = oauthError ? OAUTH_ERROR[oauthError] || 'Instagram did not complete the connection, and nothing changed here.' : null;
  const a = q.data;

  /* Still asking. Never guess — a wrong guess here is the whole reason this screen exists. */
  if (!a) {
    return (
      <WizardShell
        step={step} onStep={onStep} onLeave={onLeave}
        title="Your Instagram account"
        body="Checking whether connecting an Instagram account is open right now."
        primary={{ label: 'Checking…', onClick: () => {}, busy: true }}
        later={{ label: 'Skip this step', onClick: next }}
      />
    );
  }

  /* ---------------- already connected ---------------- */
  if (a.connected) {
    return (
      <WizardShell
        step={step} onStep={onStep} onLeave={onLeave}
        title="Instagram is connected"
        body={a.username ? `Connected as @${a.username}. Analytics and automations can use it.` : 'Analytics and automations can use it.'}
        primary={{ label: 'Last step', onClick: next }}
      >
        <div className="card flex items-center gap-3 p-4 text-[13.5px]">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-accent-ink"><Check size={17} strokeWidth={3} /></span>
          <span className="text-ink-2">Nothing else to do here. You can disconnect at any time in Settings.</span>
        </div>
      </WizardShell>
    );
  }

  /* ---------------- connecting works ---------------- */
  if (a.canConnect) {
    return (
      <WizardShell
        step={step} onStep={onStep} onLeave={onLeave}
        title="Connect your Instagram account"
        body="Optional. It adds your own numbers and lets replies to comments and DMs run on their own."
        primary={{ label: 'Connect Instagram', onClick: () => startInstagramConnect(RETURN_TO), icon: <InstagramGlyph size={16} /> }}
        later={{ label: 'Skip Instagram — everything else works without it', onClick: next }}
        footNote="You are sent to Instagram to approve it, then straight back here."
      >
        {errorLine && <OauthNote line={errorLine} />}
      </WizardShell>
    );
  }

  /* ---------------- connecting is not possible: say so, offer to tell them later ---------------- */
  const unconfigured = a.mode === 'unconfigured';
  /* No availability endpoint on this server, so we genuinely do not know. Trying is allowed — it just isn't the
     headline action, and the copy says what happens if Meta refuses. */
  const unsure = a.mode === 'unknown';
  const asked = a.waitlist || waitlist.isSuccess;
  /* The server writes one sentence for exactly this state; ours is the fallback, not the default. */
  const body = a.reason || (unconfigured
    ? 'This server has no Instagram app set up, so there is nothing to connect to.'
    : unsure
      ? 'We can’t confirm that Instagram connections are open right now.'
      : 'Connecting Instagram accounts is waiting on Meta’s review of our app. Everything above works without it, and we’ll e-mail you the moment it opens.');
  const noWaitlist = unconfigured || a.waitlistOffered === false;
  const settled = asked || noWaitlist || !!failure;
  /* Whichever address the server actually wrote down beats anything we could infer from the session. */
  const email = waitlist.data?.email || a.waitlistEmail || auth.email || null;

  const primary = settled
    ? { label: 'See what I can do now', onClick: next }
    : {
        label: 'Tell me when it’s ready',
        onClick: () => { setFailure(null); waitlist.mutate(auth.email, { onError: (e) => setFailure(e.failure) }); },
        icon: <BellRing size={16} />,
        busy: waitlist.isPending,
      };

  return (
    <WizardShell
      step={step} onStep={onStep} onLeave={onLeave}
      title={unsure ? 'Instagram may not be open yet' : 'Instagram is not open yet'}
      body={body}
      primary={primary}
      secondary={unsure ? { label: 'Try connecting anyway', onClick: () => startInstagramConnect(RETURN_TO), icon: <InstagramGlyph size={15} /> } : undefined}
      later={settled ? undefined : { label: 'Skip this — go to the last step', onClick: next }}
      footNote={unsure ? 'If Instagram refuses, you land straight back here and nothing changes.' : undefined}
    >
      {errorLine ? <OauthNote line={errorLine} className="mb-3" /> : null}
      {asked ? (
        <div className="card flex items-start gap-3 p-4 text-[13.5px]">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent text-accent-ink"><Check size={16} strokeWidth={3} /></span>
          <span className="text-ink-2">
            {waitlist.data?.message
              ? waitlist.data.message
              : <>Noted. We’ll e-mail {email ? <b>{email}</b> : 'you'} when Instagram accounts can be connected.</>}
            {' '}Nothing else is needed from you.
          </span>
        </div>
      ) : failure ? (
        <div className="card flex items-start gap-3 p-4 text-[13.5px]">
          <Mail size={16} className="mt-0.5 shrink-0 text-muted" />
          <span className="text-ink-2">
            {failure.kind === 'rejected' ? failure.message : 'We couldn’t store that request.'}{' '}
            Write to <a href={`mailto:${SUPPORT_EMAIL}?subject=Tell%20me%20when%20Instagram%20opens`} className="underline hover:text-ink">{SUPPORT_EMAIL}</a> and we’ll add you by hand.
          </span>
        </div>
      ) : (
        <ul className="space-y-2 text-[13.5px] text-ink-2">
          <li className="card p-3.5">Your saves, the notes and the search all work without an Instagram connection.</li>
          <li className="card p-3.5">Nothing you do now has to be redone once it opens.</li>
        </ul>
      )}
    </WizardShell>
  );
}

/** What came back from Meta, said once, without blame. */
function OauthNote({ line, className }: { line: string; className?: string }) {
  return (
    <div className={`card flex items-start gap-3 border-warn/40 p-4 text-[13.5px] ${className || ''}`} role="status">
      <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warn" />
      <span className="text-ink-2">{line}</span>
    </div>
  );
}
