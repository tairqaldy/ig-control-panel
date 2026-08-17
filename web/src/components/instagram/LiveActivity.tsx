/* Round 7 §5 — the live feed on the rules page: the last 20 things that happened, without switching tabs.
   Same query as the full log (react-query dedupes them) and the same pairing, so both views agree. */
import { useMemo } from 'react';
import { CornerDownRight, Inbox, RefreshCw, Terminal } from 'lucide-react';
import type { AutomationRule } from '../../lib/types-automations';
import { Skeleton } from '../ui';
import { cn, fmtAgo } from '../../lib/utils';
import { buildRows, rowStatus } from './ActivityLog';
import { useAutomationEvents } from './useAutomations';

const KIND_LABEL: Record<string, string> = { dm_in: 'DM', comment_in: 'Comment', story_reply_in: 'Story reply', dm_out: 'DM', comment_reply_out: 'Comment reply' };

export interface LiveActivityProps {
  rules: AutomationRule[];
  /** switches the page to the full activity log */
  onSeeAll?: () => void;
  /** shown in the empty state instead of "nothing yet" when nothing can arrive */
  quietReason?: string | null;
  className?: string;
}

/** The last 20 events, refreshed every 10 seconds while this tab is in front. */
export function LiveActivity({ rules, onSeeAll, quietReason, className }: LiveActivityProps) {
  const q = useAutomationEvents(200);
  const rows = useMemo(() => buildRows(q.data ?? []).slice(0, 20), [q.data]);
  const nameOf = (id: number | null) => (id ? rules.find((r) => r.id === id)?.name || `Rule #${id}` : null);

  return (
    <section className={cn('card overflow-hidden', className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2.5">
        <span className="relative flex h-2 w-2" aria-hidden>
          <span className={cn('absolute inline-flex h-full w-full rounded-full bg-accent/60', q.isFetching && 'animate-ping')} />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        <span className="text-[13px] font-medium">Live activity</span>
        <span className="text-[12px] text-muted">last 20 · refreshes every 10 seconds</span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => q.refetch()} disabled={q.isFetching} className="btn btn-ghost btn-sm text-muted !px-1.5" aria-label="Refresh now"><RefreshCw size={12} className={cn(q.isFetching && 'animate-spin')} /></button>
          {onSeeAll && <button onClick={onSeeAll} className="btn btn-ghost btn-sm text-muted">See everything</button>}
        </div>
      </div>

      {q.isLoading && !q.data ? (
        <Skeleton className="m-4 h-20" />
      ) : rows.length ? (
        <ul className="divide-y divide-line">
          {rows.map((r) => {
            const st = rowStatus(r);
            if (r.system) {
              return (
                <li key={r.key} className="flex items-start gap-2.5 px-4 py-2.5">
                  <span className="mt-0.5 h-6 w-6 shrink-0 grid place-items-center rounded-full border border-line bg-surface-2 text-muted"><Terminal size={12} /></span>
                  <span className="min-w-0 flex-1 text-[12.5px] text-muted clamp-2">{r.system.text}</span>
                  <span className="shrink-0 text-[11px] text-muted">{fmtAgo(r.ts)}</span>
                </li>
              );
            }
            const head = r.inbound ?? r.outs[0];
            const who = head?.sender_username ? `@${head.sender_username}` : head?.sender_id || 'Someone';
            const letter = who.replace(/^@/, '').slice(0, 1).toUpperCase();
            const rule = nameOf(r.outs[0]?.rule_id ?? r.inbound?.rule_id ?? null);
            return (
              <li key={r.key} className="flex items-start gap-2.5 px-4 py-2.5">
                <span className="mt-0.5 h-6 w-6 shrink-0 grid place-items-center rounded-full border border-line bg-surface-2 text-[10.5px] font-medium text-muted">{letter}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2">
                    <span className="max-w-[180px] truncate text-[12.5px] font-medium">{who}</span>
                    {r.inbound && <span className="font-mono text-[10px] uppercase tracking-wider text-muted">{KIND_LABEL[r.inbound.type] || r.inbound.type.replace(/_/g, ' ')}</span>}
                    {rule ? <span className="chip !py-[2px] !text-[10.5px]">{rule}</span> : st === 'no_match' ? <span className="text-[11.5px] text-muted">no rule matched</span> : null}
                  </div>
                  {r.inbound?.text ? <div className="mt-0.5 text-[12.5px] text-ink-2 clamp-2 break-words">{r.inbound.text}</div> : null}
                  {r.outs.slice(0, 1).map((o) => (
                    <div key={o.id} className="mt-0.5 flex items-start gap-1.5 text-[12px] text-muted">
                      <CornerDownRight size={12} className={cn('mt-0.5 shrink-0', o.error ? 'text-danger' : 'text-accent')} />
                      <span className="min-w-0 clamp-2 break-words">{o.error ? `Instagram refused it: ${o.error}` : o.text || '(no text)'}</span>
                    </div>
                  ))}
                </div>
                <span className="shrink-0 text-[11px] text-muted">{fmtAgo(r.ts)}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex items-start gap-3 px-4 py-5">
          <span className="h-8 w-8 shrink-0 grid place-items-center rounded-full border border-line bg-surface-2 text-muted"><Inbox size={15} /></span>
          <p className="text-[12.5px] text-muted leading-relaxed">
            {quietReason || 'Nothing has come in yet. Every DM, comment and story reply appears here within seconds, with the rule that answered it.'}
          </p>
        </div>
      )}
    </section>
  );
}
