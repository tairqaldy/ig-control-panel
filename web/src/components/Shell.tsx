import { type ReactNode, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { LayoutGrid, Library as LibraryIcon, MessageSquareText, Sparkles, Waypoints, Upload, Bot, Settings as SettingsIcon, Sun, Moon, LogOut, Search, Menu, X, Pause, Play, CreditCard, AlertTriangle, type LucideIcon } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth, usePalette, useQuota, useTheme } from '../lib/store';
import { cn, isMac } from '../lib/utils';
import type { WorkerStatus } from '../lib/types';
import { daysLeft, fmtLimit, planName } from '../lib/plans';
import { Logo } from './ui';

interface NavItem { to: string; label: string; icon: LucideIcon; end?: boolean; hint?: string }
const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/library', label: 'Library', icon: LibraryIcon },
  { to: '/resurface', label: 'Resurface', icon: Sparkles },
  { to: '/ask', label: 'Ask', icon: MessageSquareText, hint: 'AI' },
  { to: '/graph', label: 'Graph', icon: Waypoints },
  { to: '/import', label: 'Import', icon: Upload },
  { to: '/automations', label: 'Automations', icon: Bot },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];
const NAV_HOSTED: NavItem[] = [...NAV.slice(0, 7), { to: '/billing', label: 'Billing', icon: CreditCard }, NAV[7]];

export function useWorkerStatus() {
  return useQuery({
    queryKey: ['jobs-status'],
    queryFn: () => api.get<WorkerStatus>('/api/jobs/status'),
    refetchInterval: (q) => { const d = q.state.data; return d && (d.queued > 0 || d.running > 0) ? 2500 : 15000; },
  });
}

function WorkerPill() {
  const { data, refetch } = useWorkerStatus();
  const nav = useNavigate();
  if (!data) return null;
  const active = data.queued + data.running;
  const total = data.total || 0;
  const pct = total ? Math.round((data.analyzed / total) * 100) : 0;
  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await api.post(data.paused ? '/api/jobs/resume' : '/api/jobs/pause');
    refetch();
  };
  return (
    <button onClick={() => nav('/import')} className="w-full text-left card-flat p-3 hover:border-line-2 transition-colors group">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2 text-[12px] font-medium">
          <span className={cn('h-1.5 w-1.5 rounded-full', active && !data.paused ? 'bg-accent pulse-dot' : data.paused ? 'bg-warn' : 'bg-line-2')} />
          {active && !data.paused ? 'Analyzing' : data.paused ? (data.pauseReason === 'quota' ? 'Paused · no OpenAI credits' : data.pauseReason === 'budget' ? 'Paused · budget cap' : 'Paused') : 'Idle'}
        </div>
        <span className="font-mono text-[11px] text-muted tabular">{data.analyzed}/{total}</span>
      </div>
      <div className="h-1 rounded-full bg-line overflow-hidden">
        <motion.div className="h-full bg-accent" initial={false} animate={{ width: `${pct}%` }} transition={{ type: 'spring', stiffness: 80, damping: 20 }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted">
        <span>{active ? `${active} in queue` : data.failed ? `${data.failed} failed` : `${pct}% analyzed`}</span>
        {(active > 0 || data.paused) && (
          <span onClick={toggle} className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1 hover:text-ink">
            {data.paused ? <Play size={11} /> : <Pause size={11} />}{data.paused ? 'Resume' : 'Pause'}
          </span>
        )}
      </div>
    </button>
  );
}

/** Sidebar plan pill (hosted only): "Trial · 2d", "Pro", "Studio", "Free". Click → Billing. */
function PlanPill() {
  const { plan } = useQuota();
  if (!plan || plan.plan === 'owner') return null;
  const eff = plan.effectivePlan;
  const d = daysLeft(plan.trialEndsAt);
  const label = plan.plan === 'trial' ? (eff === 'free' ? 'Trial ended' : `Trial · ${d}d`) : planName(plan.plan);
  const tone = eff === 'free' || plan.status === 'past_due' ? 'border-warn/50 text-warn bg-warn-soft' : eff === 'trial' ? 'border-line text-ink-2' : 'chip-active';
  return <Link to="/billing" className={cn('chip !text-[11px] font-medium', tone)} title="Billing">{label}</Link>;
}

/** Trial / plan banner at the top of <main> (hosted only). Paid plans in good standing get no banner. */
function PlanBanner() {
  const { plan, openUpgrade } = useQuota();
  if (!plan || plan.plan === 'owner') return null;
  const eff = plan.effectivePlan;
  const a = plan.usage?.analyze;
  let text: ReactNode = null; let warn = false;
  if (plan.plan === 'trial' && eff !== 'free') {
    const d = daysLeft(plan.trialEndsAt);
    text = <>Trial · {d} day{d === 1 ? '' : 's'} left · {(a?.used ?? 0).toLocaleString()}/{fmtLimit(a?.limit)} saves analyzed</>;
  } else if (eff === 'free') {
    warn = true;
    text = <>{plan.plan === 'trial' ? 'Your trial ended' : 'Free plan'} · library is browse-only · analysis, Ask and automations are paused</>;
  } else if (plan.status === 'past_due') {
    warn = true;
    text = <>Payment failed · update your card in the next 7 days to keep {planName(plan.plan)}</>;
  } else if (plan.status === 'canceled') {
    text = <>{planName(plan.plan)} · canceled · access continues until the end of the period</>;
  }
  if (!text) return null;
  return (
    <div className={cn('mb-5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border px-3.5 py-2 text-[12.5px] rise', warn ? 'border-warn/40 bg-warn-soft' : 'border-line bg-surface')}>
      {warn ? <AlertTriangle size={14} className="text-warn shrink-0" /> : <Sparkles size={14} className="text-accent shrink-0" />}
      <span className="text-ink-2">{text}</span>
      <span className="ml-auto inline-flex items-center gap-2">
        {plan.status === 'past_due' && plan.canManage ? <Link to="/billing" className="btn btn-sm">Billing</Link> : null}
        {plan.status !== 'past_due' && <button onClick={() => openUpgrade()} className="btn btn-primary btn-sm">Upgrade</button>}
      </span>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { theme, toggle } = useTheme();
  const auth = useAuth();
  const { setOpen } = usePalette();
  const [mobileOpen, setMobileOpen] = useState(false);
  const items = auth.hosted ? NAV_HOSTED : NAV;

  const nav = (
    <>
      <div className="flex items-center gap-2.5 px-2 py-1.5 mb-4">
        <Logo />
        <div className="leading-tight">
          <div className="display text-[19px] tracking-tight">Resurfly</div>
          <div className="text-[10.5px] text-muted font-mono uppercase tracking-[0.12em]">Instagram saves, alive</div>
        </div>
      </div>
      <button onClick={() => setOpen(true)} className="mb-3 flex w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[13px] text-muted hover:border-line-2 hover:text-ink transition-colors">
        <Search size={14} />
        <span className="flex-1 text-left">Search or jump…</span>
        <kbd className="kbd">{isMac() ? '⌘' : 'Ctrl'} K</kbd>
      </button>
      <nav className="flex flex-col gap-0.5">
        {items.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setMobileOpen(false)} className={({ isActive }) => cn('group relative flex items-center gap-2.5 rounded-xl px-3 py-2 text-[13.5px] transition-colors', isActive ? 'text-ink' : 'text-ink-2 hover:text-ink hover:bg-surface-2/60')}>
            {({ isActive }) => (
              <>
                {isActive && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-xl bg-surface border border-line" style={{ boxShadow: 'var(--shadow)' }} transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                <n.icon size={16} className={cn('relative shrink-0', isActive ? 'text-accent' : 'text-muted group-hover:text-ink')} />
                <span className="relative flex-1">{n.label}</span>
                {n.hint && <span className="relative font-mono text-[9.5px] uppercase tracking-wider text-accent bg-accent-soft rounded px-1 py-0.5">{n.hint}</span>}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-2 pt-4">
        <WorkerPill />
        <div className="flex items-center justify-between px-1 gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-[12px] text-muted truncate">{auth.hosted && auth.email ? auth.email : `@${auth.username}`}</div>
            {auth.hosted && <PlanPill />}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={toggle} className="btn btn-ghost btn-sm !px-1.5" title="Toggle theme">{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}</button>
            <button onClick={() => auth.logout()} className="btn btn-ghost btn-sm !px-1.5" title="Log out"><LogOut size={15} /></button>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <div className="relative z-[1] min-h-full flex">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex fixed inset-y-0 left-0 w-[248px] flex-col p-4 border-r border-line/70 bg-bg/60 backdrop-blur-sm">{nav}</aside>
      {/* Mobile top bar */}
      <div className="lg:hidden fixed top-0 inset-x-0 z-40 flex items-center justify-between px-4 h-14 border-b border-line bg-bg/85 backdrop-blur">
        <div className="flex items-center gap-2"><Logo size={20} /><span className="display text-[18px]">Resurfly</span></div>
        <div className="flex items-center gap-1">
          <button onClick={() => setOpen(true)} className="btn btn-ghost btn-sm !px-2"><Search size={16} /></button>
          <button onClick={() => setMobileOpen((o) => !o)} className="btn btn-ghost btn-sm !px-2">{mobileOpen ? <X size={16} /> : <Menu size={16} />}</button>
        </div>
      </div>
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-30 bg-bg pt-16 p-4 flex flex-col">{nav}</div>
      )}
      <main className="flex-1 min-w-0 lg:pl-[248px] pt-14 lg:pt-0">
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
          {auth.hosted && <PlanBanner />}
          {children}
        </div>
      </main>
    </div>
  );
}
