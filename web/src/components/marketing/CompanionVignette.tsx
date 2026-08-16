/* Companion illustration made of UI: the extension popup (light, in the browser) → every 6 h → the device row in
   Resurfly (dark app). Static apart from a gentle pulse on the sync dot. */
import { ArrowRight, Puzzle, RefreshCw, Check } from 'lucide-react';
import { Logo } from '../ui';
import { cn } from '../../lib/utils';

export function CompanionVignette({ className }: { className?: string }) {
  return (
    <div className={cn('grid gap-3 sm:grid-cols-[1fr_auto_1fr] items-center', className)} aria-label="The Companion extension in the browser sends new saves to Resurfly every six hours">
      {/* extension popup */}
      <div className="card p-3.5 text-[12.5px] min-w-0">
        <div className="flex items-center gap-2 mb-3">
          <Logo size={18} /><span className="font-medium">Resurfly Companion</span>
          <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-accent"><span className="h-1.5 w-1.5 rounded-full bg-accent pulse-dot" /> paired</span>
        </div>
        <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 text-[12px]">
          <dt className="text-muted">Last sync</dt><dd className="tabular text-right">6 min ago</dd>
          <dt className="text-muted">New saves</dt><dd className="tabular text-right text-accent font-medium">+14</dd>
          <dt className="text-muted">Library</dt><dd className="tabular text-right">1,284 saves</dd>
        </dl>
        <div className="mt-3 flex items-center gap-2">
          <span className="btn btn-sm !cursor-default"><RefreshCw size={12} /> Sync now</span>
          <span className="text-[11px] text-muted inline-flex items-center gap-1.5"><Puzzle size={12} /> Chrome extension</span>
        </div>
      </div>
      {/* arrow */}
      <div className="flex sm:flex-col items-center justify-center gap-1 text-muted">
        <ArrowRight size={16} className="rotate-90 sm:rotate-0" />
        <span className="font-mono text-[10px]">every 6 h</span>
      </div>
      {/* device row inside Resurfly */}
      <div className="mk-dark card p-3.5 text-[12.5px] min-w-0">
        <div className="eyebrow mb-2">Import · Companion</div>
        <div className="flex items-center gap-2.5 rounded-xl border border-line bg-surface-2 px-3 py-2">
          <span className="h-7 w-7 grid place-items-center rounded-lg bg-accent-soft text-accent shrink-0"><Puzzle size={13} /></span>
          <div className="min-w-0 flex-1">
            <div className="font-medium truncate">Chrome on MacBook</div>
            <div className="text-[11px] text-muted truncate">synced 6 min ago · 14 new</div>
          </div>
          <Check size={14} className="text-accent shrink-0" />
        </div>
        <div className="mt-2.5 text-[11px] text-muted leading-snug">Analysis starts on its own. Your password stays in your browser.</div>
      </div>
    </div>
  );
}
