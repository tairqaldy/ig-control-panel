/**
 * /start — the paywall (ROUND7 §1). A tenant with `requires_payment = 1` and no subscription gets
 * 402 `payment_required` from every other API route; lib/api.ts sends them here, and this is the only
 * screen they can use until a card is on file.
 *
 * It renders outside the Shell on purpose: the sidebar polls /api/jobs/status, which sits behind the lock.
 * Every degraded case ends somewhere readable — no /api/paywall (server half not deployed yet), no Paddle
 * client token, no trial-enabled price — instead of a dead button or a spinner with no exit.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { ArrowRight, Check, CreditCard, RefreshCw, ShieldCheck } from 'lucide-react';
import { ApiError, api } from '../lib/api';
import type { PlanCatalogEntry, PlanInfo } from '../lib/types';
import { openCheckout, planFeatures, planName } from '../lib/plans';
import {
  chargeLine, chargeTodayLine, fmtChargeDate, firstChargeDate, hasTrialPrice, normalizePaywall, readLocked, reasonLine,
  type BillingInterval, type PaidPlanId, type PaywallResponse, type PaywallState,
} from '../lib/types-paywall';
import { useAuth, useQuota, useTheme } from '../lib/store';
import { cn } from '../lib/utils';
import { Logo, Modal, Skeleton } from '../components/ui';
import { IntervalToggle, priceLabel, usePlansCatalog } from '../components/Pricing';
import { priceIdFor } from '../components/UpgradeModal';
import { SUPPORT_EMAIL } from '../components/marketing';

const POLL_MS = 2500, SLOW_AFTER_MS = 60_000, POLL_MAX_MS = 10 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A completed checkout the webhook hasn't confirmed yet, remembered across page loads. The slow message on this
 * very screen tells people to reload; without this marker the reload would show "Start 3 days free" again and
 * someone who already paid could buy a second subscription. Expires so a webhook that never lands can't lock
 * the screen into "confirming" for good.
 */
const PENDING_KEY = 'rs:paywall-checkout', PENDING_MS = 30 * 60_000;
/** `{ trial }` says whether the price they bought carried free days, so the toast after a reload can't promise the wrong thing. */
function pendingCheckout(): { trial: boolean } | null {
  try {
    const [at, kind] = (localStorage.getItem(PENDING_KEY) || '').split(':');
    const t = Number(at);
    if (!Number.isFinite(t) || t <= 0 || Date.now() - t >= PENDING_MS) return null;
    return { trial: kind !== 'paid' };
  } catch { return null; } // private mode / storage disabled — one reload showing the chooser again is the worst case
}
function markCheckout(pending: { trial: boolean } | null) {
  try {
    if (pending) localStorage.setItem(PENDING_KEY, `${Date.now()}:${pending.trial ? 'trial' : 'paid'}`);
    else localStorage.removeItem(PENDING_KEY);
  } catch {}
}

/** The lock is cleared by a Paddle webhook, so "did it land yet" is a question for the server, not the client. */
async function isCleared(): Promise<boolean> {
  try {
    const r = await api.get<PaywallResponse>('/api/paywall');
    if (readLocked(r) === false) return true;
  } catch { /* 404 (route missing) or a blip — the plan below answers the same question */ }
  try {
    const p = await api.get<PlanInfo>('/api/plan');
    // /api/plan mirrors the lock. Worth reading first: a credit pack clears it without granting a plan, so the
    // plan name below would miss that case entirely.
    if (readLocked((p as { paywall?: unknown }).paywall ?? null) === false) return true;
    if (p.plan === 'pro' || p.plan === 'studio') return true;
    if (p.status === 'trialing') return true;
  } catch {}
  return false;
}

function usePaywallState(): { state: PaywallState; loading: boolean; error: boolean; refetch: () => void } {
  const { catalog } = usePlansCatalog();
  const q = useQuery({
    queryKey: ['paywall'],
    queryFn: async (): Promise<PaywallResponse | null> => {
      try { return await api.get<PaywallResponse>('/api/paywall'); } catch (e) {
        // The server half may not be deployed here (self-hosted, or this round not shipped yet) — that is "no paywall".
        if (e instanceof ApiError && (e.status === 404 || e.status === 501)) return null;
        throw e;
      }
    },
    staleTime: 10_000,
    retry: 1,
  });
  const state = useMemo(() => normalizePaywall(q.data ?? null, catalog), [q.data, catalog]);
  return { state, loading: q.isLoading, error: q.isError, refetch: () => void q.refetch() };
}

/* ------------------------------------------------------------ pieces ------------------------------------------------------------ */

function PlanChoice({ plan, interval, selected, onSelect }: { plan: PlanCatalogEntry; interval: BillingInterval; selected: boolean; onSelect: () => void }) {
  const price = priceLabel(plan, interval);
  return (
    <button
      type="button" role="radio" aria-checked={selected} onClick={onSelect}
      className={cn('text-left rounded-2xl border p-4 transition-colors', selected ? 'border-accent bg-accent-soft/40' : 'border-line bg-surface hover:border-line-2')}
      style={selected ? { boxShadow: '0 0 0 3px color-mix(in oklab, var(--accent) 14%, transparent)' } : undefined}
    >
      <div className="flex items-center gap-2">
        <span className={cn('h-4 w-4 shrink-0 rounded-full border grid place-items-center', selected ? 'border-accent' : 'border-line-2')}>
          {selected && <span className="h-2 w-2 rounded-full bg-accent" />}
        </span>
        <span className="display text-[20px]">{plan.name}</span>
        <span className="ml-auto text-right">
          <span className="display text-[24px] tabular leading-none">{price.amount}</span>
          <span className="block text-[11px] text-muted mt-0.5">{price.per}</span>
        </span>
      </div>
      <ul className="mt-3 space-y-1 text-[12.5px] text-ink-2">
        {planFeatures(plan.limits).slice(0, 3).map((f) => (
          <li key={f} className="flex items-start gap-1.5"><Check size={12} className="text-accent shrink-0 mt-[3px]" /><span>{f}</span></li>
        ))}
      </ul>
    </button>
  );
}

function DayThree({ plan, interval, trialDays, email }: { plan: PlanCatalogEntry | undefined; interval: BillingInterval; trialDays: number; email: string | null }) {
  const when = fmtChargeDate(firstChargeDate(trialDays));
  const amount = interval === 'year' ? plan?.yearly : plan?.monthly;
  const qa: Array<[string, string]> = [
    ['What am I charged?', `${amount ? `$${amount}` : 'The plan price'} on ${when}, for ${plan?.name ?? 'your plan'} ${interval === 'year' ? 'yearly' : 'monthly'}, on the card you enter now. Paddle is the merchant of record and mails the receipt${email ? ` to ${email}` : ''}. Nothing before that date.`],
    ['How do I cancel?', `Billing → Cancel. One click, no e-mail, no questions asked. Cancel before ${when} and the card is never charged; you keep the ${trialDays} free days to the end.`],
    ['What happens to my data if I cancel?', 'Nothing is deleted. Your library stays readable and exportable — JSON, CSV, Markdown, Obsidian — on the free plan. When you want it gone, Billing → Delete account removes the saves, media and tokens for good.'],
  ];
  return (
    <details className="mt-4 rounded-2xl border border-line bg-surface-2/50 px-4 py-3 group">
      <summary className="cursor-pointer list-none text-[13px] font-medium text-ink-2 flex items-center gap-2 select-none">
        <span className="text-muted transition-transform group-open:rotate-90">›</span> What happens on day {trialDays}
      </summary>
      <dl className="mt-3 space-y-3">
        {qa.map(([q, a]) => (
          <div key={q}>
            <dt className="text-[12.5px] font-medium text-ink">{q}</dt>
            <dd className="text-[12.5px] text-muted leading-relaxed mt-0.5">{a}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/* ------------------------------------------------------------ page ------------------------------------------------------------ */

export default function Paywall() {
  const auth = useAuth();
  const { plan: planInfo } = useQuota();
  const { catalog } = usePlansCatalog();
  const { theme } = useTheme();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { state, loading, error, refetch } = usePaywallState();

  // Someone who clicked a pricing card arrives with ?plan= (or ?upgrade=, the name /billing uses) — keep their choice.
  const [sp] = useSearchParams();
  const [selected, setSelected] = useState<PaidPlanId>(() => ((sp.get('plan') || sp.get('upgrade') || '').toLowerCase() === 'studio' ? 'studio' : 'pro'));
  // Monthly by default: at signup, the smaller commitment is the honest default; the toggle shows the yearly saving.
  const [interval, setInterval] = useState<BillingInterval>(() => (/^(year|yearly|annual)$/.test((sp.get('interval') || '').toLowerCase()) ? 'year' : 'month'));
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(() => !!pendingCheckout());
  const [slow, setSlow] = useState(false);
  const alive = useRef(true);
  const resumed = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { document.title = 'Start your trial — Resurfly'; return () => { document.title = 'Resurfly'; }; }, []);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  const entry = state.plans.find((p) => p.id === selected) ?? catalog.plans.find((p) => p.id === selected);
  const env = state.paddle?.env ?? planInfo?.paddle?.env ?? 'sandbox';
  const token = state.paddle?.clientToken ?? planInfo?.paddle?.clientToken ?? null;
  const trialPriceId = state.trialPriceIds[selected][interval];
  const paidPriceId = entry ? priceIdFor(planInfo, entry, interval) : null;
  const priceId = trialPriceId ?? paidPriceId;
  const withTrial = hasTrialPrice(state, selected, interval);
  const canCheckout = !!token && !!priceId;
  const lead = reasonLine(state.reason, state.trialDays);
  /** Second opinion from /api/plan, which stays open while locked: don't offer a way into the app the lock will undo. */
  const planLocked = readLocked((planInfo as { paywall?: unknown } | null)?.paywall ?? null);

  /** The Gate reads the cached /api/plan, so refresh before leaving — otherwise it bounces straight back to /start. */
  const continueToApp = useCallback(async (to: string) => {
    try { await qc.invalidateQueries(); } catch { /* a failed refetch keeps the old value; the Gate decides either way */ }
    nav(to, { replace: true });
  }, [qc, nav]);

  /** Poll until the webhook clears the lock. Keeps going past the 60 s mark, with an honest message instead of a spinner. */
  const waitForClearance = useCallback(async (trial: boolean) => {
    setConfirming(true); setSlow(false);
    const started = Date.now();
    let warned = false;
    while (Date.now() - started < POLL_MAX_MS) {
      await sleep(POLL_MS);
      if (!alive.current) return;
      if (await isCleared()) {
        markCheckout(null);
        if (!alive.current) return;
        setConfirming(false);
        await qc.invalidateQueries();
        const p = qc.getQueryData<PlanInfo>(['plan']);
        toast.success(`You're on ${planName(p?.plan ?? selected)} — card saved.`, {
          description: trial
            ? `Nothing is charged until ${fmtChargeDate(firstChargeDate(state.trialDays))}. Cancel any time from Billing.`
            : 'Cancel any time from Billing — one click, no e-mail.',
        });
        nav('/welcome', { replace: true });
        return;
      }
      if (!warned && Date.now() - started > SLOW_AFTER_MS) { warned = true; if (alive.current) setSlow(true); }
    }
    if (alive.current) setSlow(true);
  }, [qc, nav, selected, state.trialDays]);

  // Reloaded (or came back) with a paid-but-unconfirmed checkout: pick the wait up again instead of offering to buy twice.
  useEffect(() => {
    const pending = pendingCheckout();
    if (resumed.current || loading || !pending) return;
    resumed.current = true;
    if (error || state.locked) void waitForClearance(pending.trial);
    else { markCheckout(null); setConfirming(false); } // the lock is already gone, so there is nothing to confirm
  }, [loading, error, state.locked, waitForClearance]);

  const start = useCallback(async () => {
    if (!token || !priceId) return;
    setBusy(true);
    try {
      await openCheckout({
        env, token, priceId, tenantId: auth.tenantId, email: auth.email, theme,
        onCompleted: () => { markCheckout({ trial: withTrial }); setBusy(false); void waitForClearance(withTrial); },
        onClosed: () => setBusy(false),
      });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not open checkout');
    } finally {
      // The overlay covers the page anyway; releasing the button here means a Paddle-side error
      // (bad price id, blocked script) leaves a clickable button rather than "Opening checkout…" forever.
      setBusy(false);
    }
  }, [env, token, priceId, withTrial, auth.tenantId, auth.email, theme, waitForClearance]);

  const header = (
    <header className="border-b border-line/70">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 h-14 flex items-center gap-2.5">
        <Logo size={22} /><span className="display text-[19px] tracking-tight">Resurfly</span>
        <div className="ml-auto flex items-center gap-2 min-w-0">
          {auth.email && <span className="hidden sm:block text-[12px] text-muted truncate max-w-[220px]">{auth.email}</span>}
          <button type="button" onClick={() => void auth.logout()} className="btn btn-ghost btn-sm">Log out</button>
        </div>
      </div>
    </header>
  );

  const footer = (
    <footer className="mx-auto w-full max-w-3xl px-4 sm:px-6 pb-10 pt-6 text-[11.5px] text-muted">
      Questions? Write to <a className="underline hover:text-ink" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Paddle is the merchant of record and handles cards, invoices and VAT — no card details reach our server.
      {' '}Changed your mind? <button type="button" onClick={() => { setConfirmText(''); setConfirmDelete(true); }} className="underline hover:text-ink">Delete this account and everything in it</button>.
    </footer>
  );

  /**
   * Leaving without paying, in the product rather than by e-mail. `DELETE /api/account` is deliberately open while a
   * tenant is locked, but /start offered only Log out and a mailto — so the one population `/data-deletion` promises
   * "exactly what to click" had to write to us instead. This is that click.
   */
  const deleteAccount = async () => {
    setDeleting(true);
    try {
      await api.del('/api/account');
      markCheckout(null);
      toast.success('Account deleted. Nothing further will be charged.');
      window.location.assign('/');
    } catch (e) {
      setDeleting(false);
      toast.error(e instanceof Error ? e.message : 'Could not delete the account');
    }
  };

  const deleteModal = (
    <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} width="max-w-md">
      <div className="p-6">
        <div className="eyebrow mb-1">Before you go</div>
        <h3 className="display text-[24px] mb-2">Delete this account?</h3>
        <p className="text-[13px] text-ink-2 leading-relaxed">
          No card was taken, so there is nothing to cancel. Your e-mail address, anything you imported and every note
          written about it are removed from our servers. This cannot be undone. Type <code className="font-mono">DELETE</code> to confirm.
        </p>
        <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} className="input mt-4 font-mono" placeholder="DELETE" autoFocus />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => setConfirmDelete(false)} className="btn">Keep it</button>
          <button type="button" onClick={() => void deleteAccount()} disabled={confirmText !== 'DELETE' || deleting} className="btn btn-danger">{deleting ? 'Deleting…' : 'Delete everything'}</button>
        </div>
      </div>
    </Modal>
  );

  let body: ReactNode;
  if (confirming) {
    body = (
      <div className="card p-6 sm:p-8">
        <div className="flex items-start gap-3">
          <RefreshCw size={18} className="text-accent animate-spin shrink-0 mt-0.5" />
          <div>
            <h1 className="display text-[24px] leading-tight">{slow ? 'Payment went through — activation is taking longer than usual' : 'Confirming with Paddle…'}</h1>
            <p className="mt-2 text-[13.5px] text-muted leading-relaxed">
              {slow
                ? <>Your card is saved and you were not charged. We're still waiting for Paddle's confirmation and keep checking in the background. Reload the page, or write to <a className="underline hover:text-ink" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and we'll open your account by hand.</>
                : 'Your card is saved. Paddle confirms the subscription to our server, usually within a few seconds — then your account opens by itself.'}
            </p>
          </div>
        </div>
        {slow && (
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" onClick={() => window.location.reload()} className="btn btn-primary">Reload the page</button>
            <a className="btn" href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Trial started but the account is still locked')}`}>Write to support</a>
          </div>
        )}
      </div>
    );
  } else if (loading) {
    body = (
      <div className="space-y-4">
        <Skeleton className="h-9 w-3/4" />
        <Skeleton className="h-5 w-1/2" />
        <div className="grid gap-3 sm:grid-cols-2"><Skeleton className="h-40 rounded-2xl" /><Skeleton className="h-40 rounded-2xl" /></div>
        <Skeleton className="h-11 w-full rounded-xl" />
      </div>
    );
  } else if (error) {
    body = (
      <div className="card p-6 sm:p-8">
        <h1 className="display text-[26px] leading-tight">We couldn't reach the billing service</h1>
        <p className="mt-2 text-[13.5px] text-muted leading-relaxed">Nothing was charged and nothing is lost. Try again in a moment — or write to <a className="underline hover:text-ink" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and we'll sort it out.</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={refetch} className="btn btn-primary">Try again</button>
          {/* /api/plan already says this account is locked, so "continue" would land on the app and bounce right back. */}
          {planLocked === true
            ? <a className="btn btn-ghost" href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Cannot reach the Resurfly billing service')}`}>Write to support</a>
            : <button type="button" onClick={() => void continueToApp('/')} className="btn btn-ghost">Continue to Resurfly</button>}
        </div>
      </div>
    );
  } else if (!state.locked) {
    // Grandfathered tenant, self-hosted server, or the payment already landed: /start has nothing to ask for.
    const paid = planInfo?.plan === 'pro' || planInfo?.plan === 'studio';
    body = (
      <div className="card p-6 sm:p-8">
        <div className="h-9 w-9 grid place-items-center rounded-xl bg-accent-soft text-accent mb-3"><Check size={18} /></div>
        <h1 className="display text-[26px] leading-tight">{paid ? `You're on ${planName(planInfo?.plan)} — nothing to pay here` : 'Your account is open — no card needed'}</h1>
        <p className="mt-2 text-[13.5px] text-muted leading-relaxed">{reasonLine(state.reason, state.trialDays) || (paid ? 'Your subscription is active. Manage or cancel it any time from Billing.' : 'This account was set up before we started asking for a card at signup, so nothing changes for you.')}</p>
        <button type="button" onClick={() => void continueToApp('/welcome')} className="btn btn-primary mt-5">Continue setup <ArrowRight size={15} /></button>
      </div>
    );
  } else {
    body = (
      <>
        <div className="eyebrow mb-2">One step left</div>
        <h1 className="display text-[30px] sm:text-[38px] leading-[1.05] tracking-tight text-balance">
          Every Instagram save you have — transcribed, summarized, tagged, and answerable in plain questions.
        </h1>
        {/* The server's reason promises free days; drop it when this checkout can't give any, rather than contradict the fine print below. */}
        {canCheckout && withTrial && lead && <p className="mt-3 text-[13.5px] text-muted leading-relaxed">{lead}</p>}

        <div className="mt-6 flex items-center justify-between gap-3 flex-wrap">
          <IntervalToggle value={interval} onChange={(v) => setInterval(v)} catalog={catalog} />
          <span className="text-[12px] text-muted inline-flex items-center gap-1.5"><ShieldCheck size={13} /> Paddle handles the card</span>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Choose a plan">
          {state.plans.map((p) => (
            <PlanChoice key={p.id} plan={p} interval={interval} selected={selected === p.id} onSelect={() => setSelected(p.id)} />
          ))}
        </div>

        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="mt-5">
          {canCheckout ? (
            <>
              <button type="button" onClick={() => void start()} disabled={busy} className="btn btn-primary w-full py-3 text-[14px]">
                <CreditCard size={16} />
                {busy ? 'Opening checkout…' : withTrial ? `Start ${state.trialDays} days free` : `Subscribe to ${entry?.name ?? 'Resurfly'}`}
              </button>
              <p className="mt-2.5 text-[12px] text-muted leading-relaxed">
                {withTrial
                  ? <>Card required. Nothing is charged for {state.trialDays} days. Cancel any time from Billing — one click, no e-mail.</>
                  : <>Free days aren't available on this checkout, so the card is charged today. Cancel any time from Billing — one click, no e-mail.</>}
              </p>
              <p className="mt-1 text-[12px] font-medium text-ink-2 tabular">{withTrial ? chargeLine(entry, interval, state.trialDays) : chargeTodayLine(entry, interval)}</p>
            </>
          ) : (
            // No Paddle token or no price id: a disabled "Start 3 days free" would promise something this
            // server cannot do, so the one obvious action becomes the e-mail that actually gets them in.
            <>
              <a className="btn btn-primary w-full py-3 text-[14px]" href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Please open my Resurfly account')}`}>Write to {SUPPORT_EMAIL}</a>
              <p className="mt-2.5 text-[12px] text-muted leading-relaxed">Checkout isn't switched on for this server yet, so there is no card to enter. Send us a line and we'll open your account by hand — usually the same day.</p>
            </>
          )}
        </motion.div>

        <DayThree plan={entry} interval={interval} trialDays={state.trialDays} email={auth.email} />
      </>
    );
  }

  return (
    <div className="min-h-full flex flex-col bg-bg">
      {header}
      <main className="flex-1 mx-auto w-full max-w-3xl px-4 sm:px-6 py-8 sm:py-12">{body}</main>
      {footer}
      {deleteModal}
    </div>
  );
}
