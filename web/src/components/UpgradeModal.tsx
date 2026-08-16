import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sparkles, ExternalLink, ShieldCheck, Download, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import type { Limits, PlanCatalogEntry, PlanId, PlanInfo, PlansCatalog } from '../lib/types';
import { useAuth, useQuota, useTheme } from '../lib/store';
import { fmtLimit, openCheckout, planName, quotaMessage } from '../lib/plans';
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
          <IntervalToggle value={interval} onChange={setInterval} />
          <div className="text-[12px] text-muted inline-flex items-center gap-3">
            <span className="inline-flex items-center gap-1"><ShieldCheck size={12} /> Paddle handles cards & VAT</span>
            <span className="inline-flex items-center gap-1"><Download size={12} /> Export any time</span>
          </div>
        </div>
        <div className="mt-4">
          <PricingCards catalog={catalog} interval={interval} onChoose={onChoose} current={current === 'owner' ? null : current} busyPlan={busyPlan} compact hideTrial ctaLabel={(p) => (current === 'studio' && p.id === 'pro' ? 'Switch to Pro' : `Upgrade to ${p.name}`)} />
        </div>
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
