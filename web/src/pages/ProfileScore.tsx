/* Instagram Profile Score (ROUND7 §4).
 *
 * Five prefilled questions, then a scored read of the account: name and handle, bio, photo,
 * positioning, settings — each with fixes, three pastable bios, and the three things to do next.
 * It works without an Instagram connection (paste four fields), keeps showing the stored report when
 * the model is unreachable, and says plainly when the server has no such endpoint. Nothing here
 * suggests connecting Instagram: for most people that is not currently possible. */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { AlertTriangle, Gauge, Pencil, RefreshCw, Sparkles } from 'lucide-react';
import { ApiError } from '../lib/api';
import { useAuth, useQuota } from '../lib/store';
import { creditBalance } from '../lib/types-credits';
import { EMPTY_SCORE_STATE, FALLBACK_QUESTIONS, cooldownLabel, overallLabel, type ProfileScoreState } from '../lib/types-profile';
import { cn, fmtAgo, fmtNum } from '../lib/utils';
import { Empty, PageHeader, Skeleton } from '../components/ui';
import { AccountBadge } from '../components/instagram';
import {
  BioRewrites, DimensionList, ManualProfile, NextThree, Questionnaire, ScoreDelta, ScoreRing,
  answersToGoals, toManualValues, useProfileQuestions, useProfileScoreQuery, useRunScore, useSaveGoals,
  type Answers, type ManualValues,
} from '../components/profile';

type Mode = 'report' | 'questions' | 'paste';

export default function ProfileScore() {
  const auth = useAuth();
  const { plan } = useQuota();
  const scoreQ = useProfileScoreQuery();
  const questionsQ = useProfileQuestions();
  const saveGoals = useSaveGoals();
  const run = useRunScore();
  const [mode, setMode] = useState<Mode>('report');
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const state: ProfileScoreState = scoreQ.data ?? EMPTY_SCORE_STATE;
  const qState = questionsQ.data;
  // Both endpoints missing = this build of the server does not have the feature.
  const unavailable = !!qState?.unavailable && state.unavailable;
  // Both queries, not just the score: opening the questionnaire before the questions land would show the
  // unprefilled fallback, and "you only confirm what we already know" is the whole point of that screen.
  const loading = scoreQ.isLoading || questionsQ.isLoading;
  const questions = qState?.questions.length ? qState.questions : FALLBACK_QUESTIONS;
  const subject = state.subject ?? qState?.subject ?? null;
  const connected = !!subject?.connected;
  const manual = useMemo(() => toManualValues(subject), [subject]);
  const report = state.score;
  const credits = auth.hosted ? creditBalance(plan) : null;
  const cooldown = state.nextScoreAt ? Math.max(0, state.nextScoreAt - now) : 0;

  // A visible countdown on the re-score limit; only ticking while it matters.
  useEffect(() => {
    if (!state.nextScoreAt || cooldown <= 0) return;
    const t = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5000);
    return () => window.clearInterval(t);
  }, [state.nextScoreAt, cooldown]);

  const afterRun = (s: ProfileScoreState) => {
    if (s.outcome === 'profile_required') { setMode('paste'); toast(s.message || 'Paste your handle and bio first.'); return; }
    setMode('report');
    if (s.outcome === 'rate_limited') toast(s.message || `Scored recently — you can run it again ${cooldownLabel(s.cooldownSeconds)}.`);
    else if (s.outcome === 'ai_unavailable' || s.outcome === 'stale') toast(s.message || 'The model could not be reached — showing the last report.');
    // `charged.ok === false` means the report is here but the credit could not be taken (a concurrent Ask spent the
    // last one between the quota check and the charge). "Scored." over a charge that did not happen is a small lie.
    else if (s.charged && s.charged.ok === false) toast('Scored. Your credit balance was already empty, so this one is on us.');
    else if (s.charged) toast.success('Scored.');
  };
  const onRunError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 402) return; // the upgrade / buy-credits modal is already open
    toast.error(e instanceof Error ? e.message : 'Could not score the profile');
  };

  // `values` only when the paste form was just submitted: the server remembers the last paste, and
  // re-sending it from a stale render would overwrite what is stored.
  const runScore = (values?: ManualValues | null, answers?: Answers) => {
    run.mutate({ manual: values ?? null, goals: answers ? answersToGoals(answers) : null }, { onSuccess: afterRun, onError: onRunError });
  };

  const finishQuestions = (answers: Answers) => {
    saveGoals.mutate(answersToGoals(answers), {
      // A failed save must not block the score — the answers travel with the run as well.
      onSettled: () => { if (!state.canScore) { setMode('paste'); return; } runScore(null, answers); },
    });
  };

  const busy = run.isPending || saveGoals.isPending;

  /* ---------------- states before the report ---------------- */

  if (loading) {
    return (
      <div>
        <PageHeader eyebrow="Profile score · Instagram" title="How your profile reads" />
        <div className="space-y-4"><Skeleton className="h-44" /><Skeleton className="h-64" /></div>
      </div>
    );
  }

  if (unavailable) {
    return (
      <div>
        <PageHeader eyebrow="Profile score · Instagram" title="How your profile reads" />
        <Empty
          icon={<Gauge size={28} />}
          title="Profile score is not on this server yet"
          body="This Resurfly build does not expose /api/profile/score. Update the server and the page fills in on its own."
          action={<Link to="/settings" className="btn">Open Settings</Link>}
        />
      </div>
    );
  }

  if (run.isPending) {
    return (
      <div>
        <PageHeader eyebrow="Profile score · Instagram" title="Reading your profile" />
        <div className="card mx-auto max-w-xl p-6 text-center">
          <div className="mx-auto mb-4 h-10 w-10 rounded-full border-2 border-line-2 border-t-accent animate-spin" />
          <p className="text-[13.5px] text-ink-2 leading-relaxed">Scoring your name, bio, photo, positioning and settings against what you said the account is for. About twenty seconds.</p>
        </div>
      </div>
    );
  }

  if (mode === 'questions') {
    return (
      <div>
        <PageHeader eyebrow="Profile score · Instagram" title="Five questions first" subtitle="Where you want this account to go decides what counts as a good bio. Every answer is prefilled from your library and your profile — change what is wrong, keep the rest." />
        <Questionnaire
          questions={questions}
          busy={busy}
          onCancel={() => setMode('report')}
          onDone={finishQuestions}
          submitLabel={state.canScore ? 'Score my profile' : 'Next: your profile'}
        />
      </div>
    );
  }

  if (mode === 'paste') {
    return (
      <div>
        <PageHeader eyebrow="Profile score · Instagram" title="What we are scoring" />
        <ManualProfile
          initial={manual}
          busy={busy}
          connected={connected}
          onCancel={() => setMode('report')}
          onSubmit={(v) => runScore(v)}
          submitLabel={report ? 'Score again' : 'Score my profile'}
        />
      </div>
    );
  }

  if (!report) {
    return (
      <div>
        <PageHeader eyebrow="Profile score · Instagram" title="How your profile reads" />
        <Empty
          icon={<Gauge size={28} />}
          title="Score your profile"
          body={<>Answer five questions about where you want the account to go, and get a scored read of your name, bio, photo, positioning and settings — with the exact fixes and three bios you can paste.{auth.hosted ? ' One credit per score.' : ''}</>}
          action={
            <div className="flex flex-col items-center gap-2">
              <button onClick={() => setMode('questions')} className="btn btn-primary"><Sparkles size={14} /> Start — 5 questions</button>
              {!connected && <span className="text-[12px] text-muted">Works without an Instagram connection: you paste your handle, name, bio and link.</span>}
            </div>
          }
        />
        {state.stale && state.message && <p className="mt-4 text-center text-[12.5px] text-warn">{state.message}</p>}
        {scoreQ.isError && <p className="mt-4 text-center text-[12.5px] text-muted">Could not load an earlier score: {(scoreQ.error as Error)?.message}</p>}
      </div>
    );
  }

  /* ---------------- the report ---------------- */

  const scoreAgain = () => (state.canScore && connected ? runScore(null) : setMode('paste'));

  return (
    <div>
      <PageHeader
        eyebrow="Profile score · Instagram"
        title="How your profile reads"
        subtitle={subject?.username
          ? <AccountBadge size="sm" username={subject.username} name={subject.name} profilePictureUrl={subject.profilePictureUrl} followers={subject.followers} className="inline-flex" subtitle={subject.manual ? 'from what you pasted' : subject.source === 'mixed' ? 'Instagram plus what you pasted' : undefined} />
          : 'Your name, bio, photo, positioning and settings, scored against what you want the account to do.'}
        actions={<>
          <button onClick={() => setMode('questions')} className="btn"><Pencil size={13} /> Change answers</button>
          <button onClick={scoreAgain} disabled={busy || cooldown > 0} className="btn btn-primary" title={cooldown > 0 ? `Re-scoring is limited to once every ten minutes — ${cooldownLabel(cooldown)}` : undefined}>
            <RefreshCw size={14} className={cn(busy && 'animate-spin')} /> {cooldown > 0 ? `Score again ${cooldownLabel(cooldown)}` : 'Score again'}
          </button>
        </>}
      />

      {state.stale && (
        <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-warn/40 bg-warn-soft px-3.5 py-2 text-[12.5px] rise" role="status">
          <AlertTriangle size={14} className="text-warn shrink-0" />
          <span className="text-ink-2">
            {state.staleReason || state.message || 'The model could not be reached, so nothing new was computed.'} You are reading the report from {report.createdAt ? fmtAgo(report.createdAt) : 'the last run'}.
          </span>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] mb-4">
        <div className="card flex flex-col items-center gap-4 p-5 sm:flex-row sm:items-center sm:gap-6">
          <ScoreRing score={report.overall} />
          <div className="min-w-0 text-center sm:text-left">
            <div className="display text-[20px] leading-tight">{overallLabel(report.overall)}</div>
            <div className="mt-1.5 flex flex-wrap items-center justify-center gap-2 sm:justify-start">
              <ScoreDelta delta={state.delta} />
              <span className="text-[12.5px] text-muted">
                {state.delta !== null && state.previous?.createdAt ? `since ${fmtAgo(state.previous.createdAt)}` : report.createdAt ? `scored ${fmtAgo(report.createdAt)}` : 'first score'}
              </span>
            </div>
            {report.headline && <p className="mt-3 text-[13px] text-ink-2 leading-relaxed">{report.headline}</p>}
            {state.delta === null && <p className="mt-2 text-[12.5px] text-muted leading-relaxed">Change something, then score again — the next number is compared against this one.</p>}
            {credits !== null && state.cost && <p className="mt-2 text-[11.5px] text-muted">Each score costs {state.cost.credits} credit{state.cost.credits === 1 ? '' : 's'} · {fmtNum(credits)} left</p>}
          </div>
        </div>

        <NextThree actions={report.nextThree} />
      </div>

      <div className="mb-4">
        <div className="eyebrow mb-2">The five things a visitor judges</div>
        <DimensionList dimensions={report.dimensions} />
      </div>

      <BioRewrites rewrites={report.bioRewrites} current={subject?.bio ?? null} />

      {/* Always reachable, connection or not: Instagram never returns the bio or the link, so those two are
          always a paste — and someone who rewrote their bio has to be able to hand us the new one. */}
      <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
        {report.notChecked.length > 0 && <span>Not checked, because we do not have it: {report.notChecked.join(', ')}.</span>}
        <button type="button" onClick={() => setMode('paste')} className="underline underline-offset-2 hover:text-ink">
          {connected ? 'Update the bio and link we scored' : 'Update the profile we scored'}
        </button>
      </div>
    </div>
  );
}
