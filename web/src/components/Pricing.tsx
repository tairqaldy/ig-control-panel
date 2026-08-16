import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { Check } from 'lucide-react';
import { api } from '../lib/api';
import type { PlanCatalogEntry, PlanId, PlansCatalog, UsageMeter } from '../lib/types';
import { DEFAULT_CATALOG, fmtLimit, isUnlimited, meterPct, normalizeCatalog, planFeatures } from '../lib/plans';
import { cn } from '../lib/utils';

export type Interval = 'month' | 'year';

/** Public price catalog (GET /api/plans). Falls back to the bundled numbers so the landing never renders empty. */
export function usePlansCatalog(): { catalog: PlansCatalog; loading: boolean } {
  const q = useQuery({ queryKey: ['plans-catalog'], queryFn: async () => normalizeCatalog(await api.get<unknown>('/api/plans')), staleTime: 10 * 60_000, retry: 1 });
  return { catalog: q.data ?? DEFAULT_CATALOG, loading: q.isLoading };
}

export function IntervalToggle({ value, onChange, className }: { value: Interval; onChange: (v: Interval) => void; className?: string }) {
  const uid = useId(); // several toggles can be mounted at once (Billing page + modal) — keep their layout animations apart
  return (
    <div className={cn('inline-flex items-center gap-1 rounded-xl border border-line bg-surface p-1', className)} role="tablist" aria-label="Billing interval">
      {(['month', 'year'] as const).map((iv) => (
        <button key={iv} type="button" role="tab" aria-selected={value === iv} onClick={() => onChange(iv)} className={cn('relative px-3 py-1.5 text-[13px] rounded-lg transition-colors', value === iv ? 'text-ink' : 'text-muted hover:text-ink')}>
          {value === iv && <motion.span layoutId={`interval-pill-${uid}`} className="absolute inset-0 rounded-lg bg-surface-2 border border-line" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
          <span className="relative inline-flex items-center gap-1.5">{iv === 'month' ? 'Monthly' : 'Yearly'}{iv === 'year' && <span className="font-mono text-[9.5px] uppercase tracking-wider text-accent bg-accent-soft rounded px-1 py-0.5">2 months free</span>}</span>
        </button>
      ))}
    </div>
  );
}

export function priceLabel(p: PlanCatalogEntry, iv: Interval): { amount: string; per: string; note?: string } {
  if (p.id === 'trial') return { amount: '$0', per: `for ${DEFAULT_CATALOG.trialDays} days`, note: 'No card needed' };
  if (iv === 'year') { const y = p.yearly ?? 0; return { amount: `$${(y / 12).toFixed(y % 12 === 0 ? 0 : 2)}`, per: '/ month, billed yearly', note: `$${y} a year` }; }
  return { amount: `$${p.monthly ?? 0}`, per: '/ month', note: p.yearly ? `or $${p.yearly} a year` : undefined };
}

/**
 * The three cards (Trial · Pro · Studio). `onChoose(plan, interval)` decides what a click does:
 * landing → /signup, app → Paddle checkout. `current` marks the plan the tenant is on.
 */
export function PricingCards({ catalog, interval, onChoose, current, busyPlan, compact, hideTrial, ctaLabel }: { catalog: PlansCatalog; interval: Interval; onChoose: (plan: PlanCatalogEntry, interval: Interval) => void; current?: PlanId | null; busyPlan?: PlanId | null; compact?: boolean; hideTrial?: boolean; ctaLabel?: (p: PlanCatalogEntry) => string }) {
  const plans = hideTrial ? catalog.plans.filter((p) => p.id !== 'trial') : catalog.plans;
  return (
    <div className={cn('grid gap-4', plans.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2')}>
      {plans.map((p, i) => {
        const price = priceLabel(p, interval);
        const isCurrent = current === p.id;
        const featured = p.id === 'pro';
        const label = ctaLabel ? ctaLabel(p) : p.id === 'trial' ? 'Start free trial' : `Get ${p.name}`;
        return (
          <motion.div key={p.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06, duration: 0.4, ease: [0.2, 0.7, 0.2, 1] }}
            className={cn('relative flex flex-col rounded-2xl border bg-surface', compact ? 'p-4' : 'p-6', featured ? 'border-accent shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_14%,transparent)]' : 'border-line')} style={{ boxShadow: featured ? undefined : 'var(--shadow)' }}>
            {featured && <span className="absolute -top-2.5 left-5 font-mono text-[10px] uppercase tracking-[0.14em] rounded-full bg-accent text-accent-ink px-2 py-0.5">Most people</span>}
            <div className="flex items-baseline justify-between">
              <div className="display text-[24px]">{p.name}</div>
              {isCurrent && <span className="chip chip-active !text-[11px]">Current plan</span>}
            </div>
            {p.blurb && !compact && <div className="text-[12.5px] text-muted mt-1 leading-snug">{p.blurb}</div>}
            <div className="mt-4 flex items-baseline gap-1.5">
              <span className="display text-[38px] leading-none tabular">{price.amount}</span>
              <span className="text-[12.5px] text-muted">{price.per}</span>
            </div>
            {price.note && <div className="text-[11.5px] text-muted mt-1">{price.note}</div>}
            <ul className={cn('mt-4 space-y-1.5 text-[12.5px] text-ink-2', compact && 'space-y-1')}>
              {planFeatures(p.limits).slice(0, compact ? 5 : 8).map((f) => <li key={f} className="flex items-start gap-2"><Check size={13} className="text-accent shrink-0 mt-0.5" /><span>{f}</span></li>)}
              {p.id === 'trial' && <li className="flex items-start gap-2 text-muted"><Check size={13} className="shrink-0 mt-0.5 opacity-50" /><span>After {catalog.trialDays} days: browse + export only until you upgrade</span></li>}
            </ul>
            <button type="button" onClick={() => onChoose(p, interval)} disabled={isCurrent || busyPlan === p.id} className={cn('btn mt-5 w-full py-2.5', featured ? 'btn-primary' : '')}>
              {busyPlan === p.id ? 'Opening checkout…' : isCurrent ? 'Your current plan' : label}
            </button>
          </motion.div>
        );
      })}
    </div>
  );
}

/** Small progress meter used for quotas ("87 / 100 saves"). */
export function UsageBar({ label, meter, unit, hint, className, warnAt = 85 }: { label: string; meter: UsageMeter | undefined; unit?: string; hint?: string; className?: string; warnAt?: number }) {
  const pct = meterPct(meter);
  const unlimited = !meter || isUnlimited(meter.limit);
  const full = !unlimited && pct >= 100;
  return (
    <div className={cn('min-w-0', className)}>
      <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
        <span className="text-ink-2 truncate">{label}</span>
        <span className={cn('font-mono text-[11px] tabular shrink-0', full ? 'text-danger' : pct >= warnAt ? 'text-warn' : 'text-muted')}>{(meter?.used ?? 0).toLocaleString()} / {fmtLimit(meter?.limit)}{unit ? ` ${unit}` : ''}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-line overflow-hidden">
        <motion.div className={cn('h-full rounded-full', full ? 'bg-danger' : pct >= warnAt ? 'bg-warn' : 'bg-accent')} initial={false} animate={{ width: unlimited ? '4%' : `${Math.max(pct > 0 ? 3 : 0, pct)}%` }} transition={{ type: 'spring', stiffness: 90, damping: 22 }} />
      </div>
      {hint && <div className="mt-1 text-[11px] text-muted">{hint}</div>}
    </div>
  );
}
