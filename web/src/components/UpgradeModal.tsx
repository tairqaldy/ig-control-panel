import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sparkles, ExternalLink, ShieldCheck, Download, RefreshCw, Coins } from 'lucide-react';
import { api } from '../lib/api';
import type { Limits, PlanCatalogEntry, PlanId, PlanInfo, PlansCatalog } from '../lib/types';
import { useAuth, useQuota, useTheme } from '../lib/store';
import { fmtLimit, openCheckout, planName, quotaMessage } from '../lib/plans';
import { CREDIT_RULE_LINE, CREDIT_UNIT_LINE, creditBalance, creditOffer, fmtCredits, perCreditLabel, type CreditPack } from '../lib/types-credits';
import { Modal } from './ui';
import { IntervalToggle, PricingCards, usePlansCatalog, type Interval } from './Pricing';

const POLL_MS = 2000, POLL_MAX_MS = 60_000;

/** Price id for a plan+interval: prefer the tenant-scoped /api/plan payload, fall back to the public catalog. */
export function priceIdFor(plan: PlanInfo | null, p: PlanCatalogEntry, iv: Interval): string | null {
  const pp = plan?.paddle?.prices;
  const fromPlan = p.id === 'pro' ? (iv === 'year' ? pp?.proYear : pp?.proMonth) : p.id === 'studio' ? (iv === 'year' ? pp?.studioYear : pp?.studioMonth) : null;
  return fromPlan || (iv === 'year' ? p.priceIds.year : p.priceIds.month) || null;
}

/**
 * Hook shared by the modal and the Billing page: opens the Paddle overlay for a plan and, once checkout.completed fires,
 * polls /api/plan every 2 s (≤ 60 s) until the plan changes → toast + invalidate everything.
 */
export function useUpgradeCheckout() {
  const auth = useAuth();
  const { plan, refreshPlan } = useQuota();
  const { theme } = useTheme();
  const qc = useQueryClient();
  const [busyPlan, setBusyPlan] = useState<PlanId | null>(null);
  const [waiting, setWaiting] = useState(false);

  // Keeps polling even if the calling component unmounts (setState on an unmounted component is a no-op in React 19).
  const waitForPlanChange = useCallback(async (previous: PlanId | null, onDone?: () => void) => {
    setWaiting(true);
    const started = Date.now();
    let changed = false;
    while (Date.now() - started < POLL_MAX_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        const p = await api.get<PlanInfo>('/api/plan');
        if (p.plan !== previous || (p.effectivePlan !== previous && p.effectivePlan !== 'free')) { changed = true; qc.setQueryData(['plan'], p); break; }
      } catch {}
    }
    setWaiting(false);
    if (changed) {
      const p = qc.getQueryData<PlanInfo>(['plan']);
      toast.success(`Welcome to ${planName(p?.plan)} — thank you.`, { description: 'Your new limits are active. Analysis resumes automatically.' });
      onDone?.();
    } else {
      toast('Payment received — activating your plan…', { description: 'This can take a minute while Paddle confirms. The page updates by itself.' });
    }
    await refreshPlan();
    qc.invalidateQueries();
  }, [qc, refreshPlan]);

  const checkout = useCallback(async (p: PlanCatalogEntry, iv: Interval, onDone?: () => void) => {
    const env = plan?.paddle?.env || 'sandbox';
    const token = plan?.paddle?.clientToken;
    const priceId = priceIdFor(plan, p, iv);
    if (!token || !priceId) { toast.error('Checkout isn’t configured yet. Please email support and we’ll sort it out.'); return; }
    setBusyPlan(p.id);
    try {
      const previous = plan?.plan ?? null;
      await openCheckout({ env, token, priceId, tenantId: auth.tenantId, email: auth.email, theme, onCompleted: () => { void waitForPlanChange(previous, onDone); }, onClosed: () => setBusyPlan(null) });
    } catch (e: any) {
      toast.error(e?.message || 'Could not open checkout');
    } finally {
      setBusyPlan(null);
    }
  }, [plan, auth.tenantId, auth.email, theme, waitForPlanChange]);

  const openPortal = useCallback(async () => {
    try {
      const r = await api.post<{ url: string }>('/api/billing/portal');
      if (r?.url) window.open(r.url, '_blank', 'noopener');
      else toast.error('No portal link returned');
    } catch (e: any) { toast.error(e?.message || 'Could not open the billing portal'); }
  }, []);

  return { checkout, openPortal, busyPlan, waiting };
}

/**
 * Credit packs are one-time Paddle prices, so checkout is the same overlay with a different price id.
 * After `checkout.completed` we poll /api/plan until the balance goes up (the webhook writes the ledger row).
 */
export function useCreditsCheckout() {
  const auth = useAuth();
  const { plan, refreshPlan } = useQuota();
  const { theme } = useTheme();
  const qc = useQueryClient();
  const [busyPack, setBusyPack] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);

  const waitForCredits = useCallback(async (previous: number, pack: CreditPack, onDone?: () => void) => {
    setWaiting(true);
    const started = Date.now();
    let added = false;
    while (Date.now() - started < POLL_MAX_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        const p = await api.get<PlanInfo>('/api/plan');
        qc.setQueryData(['plan'], p);
        if (creditBalance(p) > previous) { added = true; break; }
      } catch {}
    }
    setWaiting(false);
    if (added) {
      const now = creditBalance(qc.getQueryData<PlanInfo>(['plan']));
      toast.success(`${fmtCredits(pack.credits)} credits added — thank you.`, { description: `Balance: ${fmtCredits(now)} credits. They are spent only after your plan allowance runs out.` });
    } else {
      toast('Payment received — adding your credits…', { description: 'This can take a minute while Paddle confirms. The balance updates by itself.' });
    }
    await refreshPlan();
    qc.invalidateQueries();
    onDone?.();
  }, [qc, refreshPlan]);

  const buyCredits = useCallback(async (pack: CreditPack, onDone?: () => void) => {
    const env = plan?.paddle?.env || 'sandbox';
    const token = plan?.paddle?.clientToken;
    if (!token || !pack.priceId) { toast.error('Credit packs aren’t configured on this server yet. Email support and we’ll sort it out.'); return; }
    setBusyPack(pack.id);
    try {
      const previous = creditBalance(plan);
      await openCheckout({ env, token, priceId: pack.priceId, tenantId: auth.tenantId, email: auth.email, theme, onCompleted: () => { void waitForCredits(previous, pack, onDone); }, onClosed: () => setBusyPack(null) });
    } catch (e: any) {
      toast.error(e?.message || 'Could not open checkout');
    } finally {
      setBusyPack(null);
    }
  }, [plan, auth.tenantId, auth.email, theme, waitForCredits]);

  return { buyCredits, busyPack, waiting };
}

/** The three packs as buttons (Billing page and the upgrade modal). `compact` is the modal's denser row. */
export function CreditPacks({ packs, compact, onDone, className }: { packs: CreditPack[]; compact?: boolean; onDone?: () => void; className?: string }) {
  const { buyCredits, busyPack, waiting } = useCreditsCheckout();
  const purchasable = packs.some((p) => p.priceId); // no Paddle price ids configured → show the catalog, not dead buttons
  const middle = packs.length === 3 ? packs[1].id : null;
  return (
    <div className={className}>
      <div className="grid gap-3 sm:grid-cols-3">
        {packs.map((p) => (
          <div key={p.id} className={`rounded-xl border border-line bg-surface ${compact ? 'p-3' : 'p-4'}`}>
            <div className="flex items-baseline gap-1.5">
              <span className={`display tabular ${compact ? 'text-[22px]' : 'text-[26px]'}`}>{fmtCredits(p.credits)}</span>
              <span className="text-[12px] text-muted">credits</span>
            </div>
            <div className="text-[12px] text-muted mt-0.5">${p.price} one time{perCreditLabel(p) ? ` · ${perCreditLabel(p)}` : ''}</div>
            {purchasable && (
              <button type="button" onClick={() => void buyCredits(p, onDone)} disabled={busyPack === p.id || !p.priceId} className={`btn btn-sm w-full mt-3 ${p.id === middle ? 'btn-primary' : ''}`} title={p.priceId ? undefined : 'This pack has no price configured on the server yet'}>
                {busyPack === p.id ? 'Opening checkout…' : `Buy for $${p.price}`}
              </button>
            )}
          </div>
        ))}
      </div>
      {!purchasable && <div className="mt-2 text-[12px] text-muted">Credit packs aren’t switched on for this server yet. Email support if you need one.</div>}
      {waiting && <div className="mt-3 flex items-center gap-2 rounded-xl border border-accent/30 bg-accent-soft/50 px-3 py-2 text-[12.5px]"><RefreshCw size={13} className="animate-spin text-accent" /> Payment received — waiting for Paddle to confirm your credits…</div>}
    </div>
  );
}

/** Human name for the metric the server reported in a 402 (`analyze`, `ask`, `rules`, `sends`, `harvests`, …). */
function metricLabel(metric: string, window?: string | null): string {
  switch (metric) {
    case 'analyze': return window === 'month' ? 'saves analyzed this month' : 'saves analyzed';
    case 'analyzeMonth': return 'saves analyzed this month';
    case 'ask': return window === 'minute' ? 'questions per minute' : 'questions this month';
    case 'askMinute': case 'ask_minute': return 'questions per minute';
    case 'rules': return 'automation rules';
    case 'sends': return 'automated replies this month';
    case 'harvests': return 'imports today';
    case 'graph': case 'graphNodes': return 'graph size';
    default: return metric.replace(/[_-]/g, ' ');
  }
}

/** "Pro: 300 · Studio: 1,500" for the limit that was hit, read from the live catalog — so the cards below answer the exact question. */
function planCompare(metric: string, window: string | null | undefined, catalog: PlansCatalog): string | null {
  const key: keyof Limits | null =
    metric === 'analyze' ? (window === 'month' ? 'analyzePerMonth' : 'analyzeTotal')
      : metric === 'analyzeMonth' ? 'analyzePerMonth'
        : metric === 'ask' ? (window === 'minute' ? 'askPerMinute' : 'askPerMonth')
          : metric === 'askMinute' || metric === 'ask_minute' ? 'askPerMinute'
            : metric === 'rules' ? 'rules' : metric === 'sends' ? 'sendsPerMonth' : metric === 'harvests' ? 'harvestsPerDay' : metric === 'graph' || metric === 'graphNodes' ? 'graphNodes' : null;
  if (!key) return null;
  const unit = key === 'analyzeTotal' ? 'saves in total' : key === 'analyzePerMonth' ? 'new saves a month' : key === 'askPerMonth' ? 'questions a month' : key === 'askPerMinute' ? 'questions a minute' : key === 'rules' ? 'rules' : key === 'sendsPerMonth' ? 'replies a month' : key === 'harvestsPerDay' ? 'imports a day' : 'graph nodes';
  const parts = catalog.plans.filter((p) => p.id === 'pro' || p.id === 'studio').map((p) => `${p.name} ${fmtLimit(p.limits[key])}`);
  return parts.length ? `${parts.join(' · ')} ${unit}.` : null;
}

/** Global soft-wall. Mounted once in the Shell; opens on the `rs:quota` event or via useQuota().openUpgrade(). */
export function UpgradeModal() {
  const { open, intent, close, plan } = useQuota();
  const auth = useAuth();
  const { catalog } = usePlansCatalog();
  const [interval, setInterval] = useState<Interval>('year');
  useEffect(() => { if (open && intent?.interval) setInterval(intent.interval); }, [open, intent]);
  const { checkout, openPortal, busyPlan, waiting } = useUpgradeCheckout();
  const msg = quotaMessage(intent?.quota ?? null);
  const current = plan?.effectivePlan ?? plan?.plan ?? null;
  const q = intent?.quota ?? null;
  const compare = q ? planCompare(q.metric, q.window, catalog) : null;
  // A 402 from a metered action (analyze / ask / sends) carries `credits` — then buying credits is a real second path.
  const offer = creditOffer(q, catalog.creditPacks);
  const onChoose = (p: PlanCatalogEntry, iv: Interval) => { void checkout(p, iv, close); };
  return (
    <Modal open={open} onClose={close} width="max-w-4xl">
      <div className="p-6 sm:p-8">
        <div className="flex items-start gap-3 pr-8">
          <div className="h-9 w-9 shrink-0 grid place-items-center rounded-xl bg-accent-soft text-accent"><Sparkles size={17} /></div>
          <div>
            <div className="eyebrow mb-1">{q ? `${planName(q.plan)} · ${metricLabel(q.metric, q.window)}${q.limit !== null && q.limit !== undefined ? ` · ${q.used.toLocaleString()} of ${fmtLimit(q.limit)} used` : ''}` : current ? `You're on ${planName(current)}` : 'Plans'}</div>
            <h2 className="display text-[26px] sm:text-[30px] leading-[1.05]">{intent?.reason || msg.title}</h2>
            <p className="mt-2 text-[13.5px] text-muted leading-relaxed max-w-2xl">{msg.body}{compare ? ` ${compare}` : ''}{q && plan?.effectivePlan === 'free' ? ' Your library stays readable and exportable either way.' : ''}</p>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <IntervalToggle value={interval} onChange={setInterval} catalog={catalog} />
          <div className="text-[12px] text-muted inline-flex items-center gap-3">
            <span className="inline-flex items-center gap-1"><ShieldCheck size={12} /> Paddle handles cards & VAT</span>
            <span className="inline-flex items-center gap-1"><Download size={12} /> Export any time</span>
          </div>
        </div>
        <div className="mt-4">
          <PricingCards catalog={catalog} interval={interval} onChoose={onChoose} current={current === 'owner' ? null : current} busyPlan={busyPlan} compact hideTrial hideCreditNote={!!offer} ctaLabel={(p) => (current === 'studio' && p.id === 'pro' ? 'Switch to Pro' : `Upgrade to ${p.name}`)} />
        </div>

        {offer && (
          <div className="mt-5 rounded-2xl border border-line bg-surface-2/50 p-4">
            <div className="flex items-start gap-2.5">
              <div className="h-8 w-8 shrink-0 grid place-items-center rounded-lg bg-accent-soft text-accent"><Coins size={15} /></div>
              <div className="min-w-0">
                <div className="eyebrow mb-0.5">Or keep your plan and top up</div>
                <h3 className="text-[14.5px] font-semibold">Buy credits — you have {fmtCredits(offer.balance)}, this needs {fmtCredits(offer.needed)}</h3>
                <p className="text-[12px] text-muted mt-1 max-w-2xl">{CREDIT_UNIT_LINE} {CREDIT_RULE_LINE}</p>
              </div>
            </div>
            <CreditPacks packs={offer.packs} compact onDone={close} className="mt-3" />
          </div>
        )}
        {waiting && <div className="mt-4 flex items-center gap-2 rounded-xl border border-accent/30 bg-accent-soft/50 px-3 py-2 text-[12.5px]"><RefreshCw size={13} className="animate-spin text-accent" /> Payment received — waiting for Paddle to confirm your plan…</div>}

        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4 text-[12px] text-muted">
          <span>Cancel any time from Billing. Access continues until the end of the paid period.</span>
          <span className="ml-auto inline-flex items-center gap-2">
            {plan?.canManage && <button onClick={openPortal} className="btn btn-sm">Manage subscription <ExternalLink size={12} /></button>}
            <button onClick={close} className="btn btn-ghost btn-sm">Not now</button>
          </span>
        </div>
        {auth.email && <div className="mt-2 text-[11px] text-muted-2">Receipts go to {auth.email}.</div>}
      </div>
    </Modal>
  );
}
