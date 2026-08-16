import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { CreditCard, ExternalLink, Sparkles, Receipt, Trash2, AlertTriangle, RefreshCw, Download } from 'lucide-react';
import { api } from '../lib/api';
import type { PlanCatalogEntry, PlanId } from '../lib/types';
import { useAuth, useQuota } from '../lib/store';
import { daysLeft, fmtLimit, isUnlimited, planName, toMs } from '../lib/plans';
import { fmtDate } from '../lib/utils';
import { PageHeader, Modal, Skeleton } from '../components/ui';
import { IntervalToggle, PricingCards, UsageBar, usePlansCatalog, type Interval } from '../components/Pricing';
import { useUpgradeCheckout } from '../components/UpgradeModal';

const fmtTs = (t: number | null | undefined) => { const ms = toMs(t); return ms ? fmtDate(Math.floor(ms / 1000)) : ''; };

export default function Billing() {
  const auth = useAuth();
  const { plan, planLoading, refreshPlan, openUpgrade } = useQuota();
  const { catalog } = usePlansCatalog();
  const { checkout, openPortal, busyPlan, waiting } = useUpgradeCheckout();
  const [interval, setInterval] = useState<Interval>('year');
  const [sp, setSp] = useSearchParams();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  // /billing?upgrade=pro&interval=year (from /signup?plan=pro) → open the modal straight away.
  useEffect(() => {
    const up = sp.get('upgrade');
    if (up === 'pro' || up === 'studio') { openUpgrade({ preselect: up, interval: sp.get('interval') === 'month' ? 'month' : 'year' }); setSp({}, { replace: true }); }
  }, [sp, setSp, openUpgrade]);

  const eff = plan?.effectivePlan ?? plan?.plan ?? null;
  const isPaid = plan?.plan === 'pro' || plan?.plan === 'studio';
  const trialDays = daysLeft(plan?.trialEndsAt);
  const statusLine = (() => {
    if (!plan) return '';
    if (plan.plan === 'owner') return 'Owner account · no limits';
    if (plan.plan === 'trial') return eff === 'free' ? `Trial ended ${fmtTs(plan.trialEndsAt)} · library is browse-only` : `Trial · ${trialDays} day${trialDays === 1 ? '' : 's'} left · ends ${fmtTs(plan.trialEndsAt)}`;
    if (plan.plan === 'free') return 'Free · browse and export only';
    const st = plan.status || 'active';
    if (st === 'canceled') return `Canceled · access until ${fmtTs(plan.renewsAt)}`;
    if (st === 'past_due') return `Payment failed · update your card to keep ${planName(plan.plan)}`;
    if (st === 'paused') return 'Paused';
    return `Active · renews ${fmtTs(plan.renewsAt)}`;
  })();
  const priceLine = (() => {
    const p = catalog.plans.find((x) => x.id === plan?.plan);
    if (!p || !isPaid) return null;
    return `$${p.monthly}/mo or $${p.yearly}/yr`;
  })();

  const doDelete = async () => {
    setDeleting(true);
    try {
      await api.del('/api/account');
      toast.success('Account deleted. Goodbye — and thanks for trying Resurfly.');
      await auth.logout();
    } catch (e: any) { toast.error(e?.message || 'Could not delete the account'); setDeleting(false); }
  };

  const onChoose = (p: PlanCatalogEntry, iv: Interval) => { void checkout(p, iv); };
  const u = plan?.usage;

  return (
    <div className="max-w-5xl">
      <PageHeader eyebrow="Billing" title={<>Your plan{plan ? <span className="text-muted"> · {planName(plan.plan)}</span> : ''}</>} subtitle="What you're on, what you've used this month, and where to change it. Paddle handles cards, invoices and VAT; nothing card-related is stored here."
        actions={<>
          {plan?.canManage && <button onClick={openPortal} className="btn"><Receipt size={14} /> Invoices & subscription <ExternalLink size={12} /></button>}
          {plan && plan.plan !== 'owner' && plan.plan !== 'studio' && <button onClick={() => openUpgrade()} className="btn btn-primary"><Sparkles size={14} /> {isPaid ? 'Change plan' : 'Upgrade'}</button>}
        </>} />

      {planLoading && !plan ? <Skeleton className="h-40 mb-4" /> : plan ? (
        <>
          {/* Current plan */}
          <div className={`card p-5 mb-4 ${plan.status === 'past_due' || eff === 'free' ? 'border-warn/50' : ''}`}>
            <div className="flex flex-wrap items-start gap-4">
              <div className="h-11 w-11 shrink-0 grid place-items-center rounded-xl bg-accent-soft text-accent"><CreditCard size={20} /></div>
              <div className="min-w-[220px] flex-1">
                <div className="flex items-center gap-2 flex-wrap"><span className="display text-[24px]">{planName(plan.plan)}</span>{eff !== plan.plan && <span className="chip !text-[11px] border-warn/40 text-warn">acts as {planName(eff)}</span>}{isPaid && <span className="chip chip-active !text-[11px]">{plan.status || 'active'}</span>}</div>
                <div className="text-[13px] text-ink-2 mt-0.5">{statusLine}</div>
                {priceLine && <div className="text-[12px] text-muted mt-0.5">{priceLine} · billed by Paddle</div>}
                {auth.email && <div className="text-[12px] text-muted mt-1">Account: {auth.email}{auth.tenantId ? ` · workspace #${auth.tenantId}` : ''}</div>}
              </div>
              <div className="flex flex-col gap-2 min-w-[200px]">
                {plan.plan !== 'owner' && plan.plan !== 'studio' && <button onClick={() => openUpgrade()} className="btn btn-primary btn-sm"><Sparkles size={13} /> {isPaid ? 'Upgrade to Studio' : 'Upgrade'}</button>}
                {plan.canManage && <button onClick={openPortal} className="btn btn-sm">Manage subscription <ExternalLink size={12} /></button>}
                <button onClick={() => { void refreshPlan(); }} className="btn btn-ghost btn-sm text-muted"><RefreshCw size={12} /> Refresh</button>
              </div>
            </div>
            {(eff === 'free' || plan.status === 'past_due') && (
              <div className="mt-4 flex items-start gap-2 rounded-xl bg-warn-soft border border-warn/30 px-3 py-2 text-[12.5px]"><AlertTriangle size={14} className="text-warn shrink-0 mt-0.5" />
                {plan.status === 'past_due' ? <span>Your last payment failed. Update the card in the Paddle portal — access continues for a 7-day grace period, then the library becomes browse-only.</span> : <span>Analysis, Ask and automations are paused. Your saves are kept and exportable; upgrade to continue where you left off. Data from ended trials is deleted 30 days after the trial end unless you upgrade.</span>}
              </div>
            )}
            {waiting && <div className="mt-3 flex items-center gap-2 rounded-xl border border-accent/30 bg-accent-soft/50 px-3 py-2 text-[12.5px]"><RefreshCw size={13} className="animate-spin text-accent" /> Payment received — waiting for Paddle to confirm your plan…</div>}
          </div>

          {/* Usage */}
          <div className="card p-5 mb-4">
            <div className="flex items-center justify-between mb-4"><div><div className="eyebrow mb-0.5">Usage</div><h3 className="text-[15px] font-semibold">This month on {planName(eff)}</h3></div><span className="text-[12px] text-muted">Monthly counters reset on the 1st (UTC). Harvests reset daily.</span></div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-5">
              <UsageBar label="Saves analyzed · total" meter={u?.analyze} hint={isUnlimited(u?.analyze?.limit) ? 'No cap on this plan' : `${fmtLimit(u?.analyze?.limit)} included for the life of the plan`} />
              <UsageBar label="Saves analyzed · this month" meter={u?.analyzeMonth} hint={u?.analyzeMonth && u.analyzeMonth.limit === 0 ? 'No new analysis on this plan' : undefined} />
              <UsageBar label="Ask questions" meter={u?.ask} />
              <UsageBar label="Automated replies sent" meter={u?.sends} />
              <UsageBar label="Automation rules" meter={u?.rules} hint={isUnlimited(u?.rules?.limit) ? 'Unlimited rules' : undefined} />
              <UsageBar label="Harvest imports today" meter={u?.harvests} />
            </div>
          </div>

          {/* Plans */}
          {plan.plan !== 'owner' && (
            <div className="mb-4">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3"><div><div className="eyebrow mb-0.5">Plans</div><h3 className="text-[15px] font-semibold">Compare and switch</h3></div><IntervalToggle value={interval} onChange={setInterval} /></div>
              <PricingCards catalog={catalog} interval={interval} onChoose={onChoose} current={(plan.plan as PlanId)} busyPlan={busyPlan} hideTrial compact ctaLabel={(p) => (plan.plan === 'studio' && p.id === 'pro' ? 'Switch to Pro' : isPaid ? `Switch to ${p.name}` : `Upgrade to ${p.name}`)} />
              <div className="mt-2 text-[12px] text-muted">Switching plans mid-period is prorated by Paddle. Downgrades apply at the next renewal.</div>
            </div>
          )}

          {/* Export + danger zone */}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="card-flat p-5">
              <div className="flex items-center gap-2 mb-1"><Download size={15} className="text-accent" /><h3 className="text-[14px] font-semibold">Take your data with you</h3></div>
              <p className="text-[12.5px] text-muted leading-relaxed">Everything — analyses, transcripts, tags, notes — exports from the Library page as JSON, CSV, Markdown or an Obsidian vault, on every plan, at any time.</p>
              <a href="/api/export?format=json" className="btn btn-sm mt-3"><Download size={13} /> Export JSON now</a>
            </div>
            {plan.plan !== 'owner' && (
              <div className="card-flat p-5 border-danger/30">
                <div className="flex items-center gap-2 mb-1"><Trash2 size={15} className="text-danger" /><h3 className="text-[14px] font-semibold">Delete account</h3></div>
                <p className="text-[12.5px] text-muted leading-relaxed">Wipes your saves, media, analyses and settings from our servers and cancels any subscription. This cannot be undone — export first.</p>
                <button onClick={() => { setConfirmText(''); setConfirmDelete(true); }} className="btn btn-danger btn-sm mt-3"><Trash2 size={13} /> Delete my account…</button>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="card-flat p-6 text-[13px] text-muted">Billing is only available on the hosted version of Resurfly.</div>
      )}

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} width="max-w-md">
        <div className="p-6">
          <div className="eyebrow mb-1">Danger zone</div>
          <h3 className="display text-[24px] mb-2">Delete this account?</h3>
          <p className="text-[13px] text-ink-2 leading-relaxed">All saves, media, analyses, automation rules and settings will be removed. Any active subscription is canceled. Type <code className="font-mono">DELETE</code> to confirm.</p>
          <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} className="input mt-4 font-mono" placeholder="DELETE" autoFocus />
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setConfirmDelete(false)} className="btn">Cancel</button>
            <button onClick={doDelete} disabled={confirmText !== 'DELETE' || deleting} className="btn btn-danger">{deleting ? 'Deleting…' : 'Delete everything'}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
