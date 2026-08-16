import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { KeyRound, Copy, Laptop, RefreshCw, Trash2, ShieldCheck, ShieldOff, AlertTriangle, ExternalLink, Check, CloudOff } from 'lucide-react';
import type { CompanionDevice } from '../../lib/types-instagram';
import { cn, copyText, fmtAgo } from '../../lib/utils';
import { Skeleton } from '../ui';
import { ChromeGlyph } from '../instagram/icons';
import { COMPANION_INSTALL_URL, COMPANION_IS_STORE, useCompanionDevices, useDisableServerHarvest, usePairCode, useRevokeDevice } from './useCompanion';

function useCountdown(expiresAt: number | null | undefined) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setLeft(Math.max(0, expiresAt - Math.floor(Date.now() / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  return left;
}

/**
 * "Get pairing code" → RSF-XXXX-XXXX with a 5-minute countdown. Standalone so Welcome can embed just this.
 * `primary` = the button is the screen's main action; `secondary` = extra controls shown next to the button (hidden while a code is showing).
 */
export function PairingCode({ className, autoStart = false, primary = true, secondary }: { className?: string; autoStart?: boolean; primary?: boolean; secondary?: ReactNode }) {
  const pair = usePairCode();
  const left = useCountdown(pair.data?.expiresAt);
  const expired = !!pair.data && left <= 0;
  useEffect(() => { if (autoStart && !pair.data && !pair.isPending) pair.mutate(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [autoStart]);
  return (
    <div className={className}>
      <AnimatePresence mode="wait">
        {pair.data && !expired ? (
          <motion.div key="code" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-xl border border-accent/40 bg-accent-soft/50 p-3">
            <div className="flex flex-wrap items-center gap-3">
              <code className="display font-mono text-[24px] sm:text-[26px] tracking-[0.12em] tabular text-ink select-all">{pair.data.code}</code>
              <button onClick={() => { void copyText(pair.data!.code); toast.success('Code copied'); }} className="btn btn-sm"><Copy size={12} /> Copy</button>
              <span className="ml-auto font-mono text-[11.5px] text-muted tabular">expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>
            </div>
            <div className="mt-2 text-[12px] text-muted">Open the Companion popup in Chrome and paste this code. It works once.</div>
          </motion.div>
        ) : (
          <motion.div key="btn" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-wrap items-center gap-2">
            <button onClick={() => pair.mutate()} disabled={pair.isPending} className={cn('btn', primary && 'btn-primary')}><KeyRound size={14} /> {pair.isPending ? 'Creating…' : expired ? 'New pairing code' : 'Get pairing code'}</button>
            {secondary}
            {expired && <span className="text-[12px] text-muted">The previous code expired.</span>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function DeviceRow({ d, onRevoke, onDisable, busy }: { d: CompanionDevice; onRevoke: () => void; onDisable: () => void; busy?: boolean }) {
  const invalid = d.serverHarvest && d.igSessionStatus === 'invalid';
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]">
      <span className="h-8 w-8 shrink-0 grid place-items-center rounded-lg bg-surface-2 text-muted"><Laptop size={15} /></span>
      <div className="min-w-[160px] flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{d.name || `Device #${d.id}`}</span>
          {d.serverHarvest ? (
            invalid ? <span className="chip !text-[11px] border-warn/40 text-warn"><AlertTriangle size={11} /> background session signed out</span> : <span className="chip chip-active !text-[11px]"><ShieldCheck size={11} /> syncs in background too</span>
          ) : <span className="chip !text-[11px] text-muted"><ShieldOff size={11} /> syncs while Chrome is open</span>}
        </div>
        <div className="mt-0.5 text-[11.5px] text-muted">
          {d.lastHarvestAt ? <>last sync {fmtAgo(d.lastHarvestAt)}{d.lastHarvestCount != null ? ` · ${d.lastHarvestCount} new` : ''}</> : 'no sync yet — the first one starts on its own within a minute of pairing'}
          {d.lastSeenAt ? ` · seen ${fmtAgo(d.lastSeenAt)}` : ''}
          {d.createdAt ? ` · paired ${fmtAgo(d.createdAt)}` : ''}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {d.serverHarvest && <button onClick={onDisable} disabled={busy} className="btn btn-ghost btn-sm text-muted" title="Delete the stored Instagram session; the extension keeps syncing while your browser is open"><CloudOff size={13} /> Turn off background</button>}
        <button onClick={onRevoke} disabled={busy} className="btn btn-ghost btn-sm text-muted hover:text-danger" title="Remove this device" aria-label="Remove this device"><Trash2 size={13} /></button>
      </div>
    </div>
  );
}

/** Paired devices with last sync + opt-in status, revoke, and "turn off background". Used on Import and in Settings → Companion. */
export function CompanionDevices({ className, emptyHint = 'No devices paired yet.' }: { className?: string; emptyHint?: string }) {
  const q = useCompanionDevices();
  const revoke = useRevokeDevice();
  const disable = useDisableServerHarvest();
  if (q.isLoading && !q.data) return <Skeleton className={cn('h-14', className)} />;
  const d = q.data;
  if (!d || d.unavailable) return <div className={cn('text-[12.5px] text-muted', className)}>Companion pairing is not available on this server yet.</div>;
  return (
    <div className={className}>
      {d.notice && <div className="mb-2 flex items-start gap-2 rounded-xl border border-warn/40 bg-warn-soft px-3 py-2 text-[12.5px]"><AlertTriangle size={14} className="text-warn shrink-0 mt-0.5" /><span>{d.notice}</span></div>}
      {d.devices.length ? (
        <div className="card-flat divide-y divide-line">
          {d.devices.map((dev) => (
            <DeviceRow key={dev.id} d={dev} busy={revoke.isPending || disable.isPending}
              onRevoke={() => { if (confirm(`Remove ${dev.name || `device #${dev.id}`}? It stops syncing until paired again.`)) revoke.mutate(dev.id); }}
              onDisable={() => disable.mutate(dev.id)} />
          ))}
        </div>
      ) : <div className="text-[12.5px] text-muted">{emptyHint}</div>}
    </div>
  );
}

const STEPS: Array<[string, ReactNode]> = [
  ['Install the extension in Chrome', <>From the Chrome Web Store, or <b>Load unpacked</b> for self-hosters.</>],
  ['Get a pairing code here, paste it in the popup', 'Links the extension to this workspace. Valid 5 minutes, works once.'],
  ['Saves arrive on their own', 'The first sync brings your whole saved list; later syncs only fetch what is new.'],
];

/**
 * Import → 1. Companion (recommended): three lines, one primary action, devices. `compact` = Welcome/onboarding variant without the intro.
 */
export function CompanionCard({ compact = false, className }: { compact?: boolean; className?: string }) {
  const q = useCompanionDevices();
  const devices = q.data?.devices ?? [];
  const paired = devices.length > 0;
  const anyBackground = devices.some((d) => d.serverHarvest && d.igSessionStatus !== 'invalid');
  const installBtn = (
    <a href={COMPANION_INSTALL_URL} target="_blank" rel="noreferrer" className="btn"><ChromeGlyph size={14} /> {COMPANION_IS_STORE ? 'Install from Chrome Web Store' : 'Install the Companion'} <ExternalLink size={12} /></a>
  );
  return (
    <div className={cn('card p-5 sm:p-6', className)}>
      {!compact && (
        <div className="flex flex-wrap items-start gap-3 mb-4">
          <span className="h-9 w-9 shrink-0 grid place-items-center rounded-xl bg-accent-soft text-accent"><ChromeGlyph size={17} /></span>
          <div className="min-w-[200px] flex-1">
            <h3 className="text-[15px] font-semibold">Resurfly Companion for Chrome</h3>
            <p className="mt-0.5 text-[13px] text-muted leading-relaxed">Reads your saved posts while you are logged in to instagram.com and sends new ones here every 6 hours. Pair it once; nothing to run by hand after that.</p>
          </div>
          {paired && <span className="chip chip-active"><Check size={12} /> {devices.length} device{devices.length === 1 ? '' : 's'} paired{anyBackground ? ' · background on' : ''}</span>}
        </div>
      )}
      <div className={cn('grid gap-5', !compact && 'lg:grid-cols-[1.1fr_1fr]')}>
        <div>
          {!compact && (
            <ol className="space-y-2.5 text-[13px]">
              {STEPS.map(([t, d], i) => (
                <li key={i} className="flex gap-3"><span className="font-mono text-[11px] text-accent pt-0.5 w-5 shrink-0">{String(i + 1).padStart(2, '0')}</span><div><div className="font-medium">{t}</div><div className="text-muted mt-0.5 leading-relaxed">{d}</div></div></li>
              ))}
            </ol>
          )}
          <PairingCode className={cn(!compact && 'mt-5')} primary={!paired} secondary={installBtn} />
        </div>
        <div>
          <div className="flex items-center justify-between mb-2"><div className="eyebrow">Paired devices</div><button onClick={() => q.refetch()} className="btn btn-ghost btn-sm !px-1.5 text-muted" title="Refresh" aria-label="Refresh device list"><RefreshCw size={12} className={cn(q.isFetching && 'animate-spin')} /></button></div>
          <CompanionDevices emptyHint="None yet — get a pairing code and paste it in the Companion popup." />
          {!compact && !anyBackground && !q.data?.unavailable && (
            <div className="mt-3 text-[12px] text-muted leading-relaxed">Optional, in the popup: let it sync while Chrome is closed. That stores your Instagram session here, encrypted; you can turn it off from this list any time.</div>
          )}
        </div>
      </div>
    </div>
  );
}
