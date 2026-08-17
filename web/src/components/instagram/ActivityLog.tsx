/* Round 6 §2 — the activity log that answers "why didn't it fire?".
   Inbound events are paired with the replies that went out within three minutes, so one row reads as one conversation. */
import { useMemo, useState } from 'react';
import { CornerDownRight, FlaskConical, Inbox, RefreshCw, Terminal } from 'lucide-react';
import type { AutomationEvent, AutomationRule, LogFilter } from '../../lib/types-automations';
import { Empty, Skeleton } from '../ui';
import { cn, fmtAgo } from '../../lib/utils';
import { useAutomationEvents } from './useAutomations';

export interface Row { key: string; ts: number; inbound: AutomationEvent | null; outs: AutomationEvent[]; system: AutomationEvent | null }

/**
 * Pair each inbound event with the outbound events that followed it for the same sender within 3 minutes.
 * Events arrive newest-first, so a reply sits at a *lower* index than the message that triggered it. Claiming
 * happens in that same order, which gives every reply to the closest inbound that precedes it in time.
 */
export function buildRows(events: AutomationEvent[]): Row[] {
  const claimedBy = new Map<number, number>();          // outbound id → inbound id
  const outsFor = new Map<number, AutomationEvent[]>(); // inbound id → its replies, oldest first
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.direction !== 'in') continue;
    const outs: AutomationEvent[] = [];
    for (let j = i - 1; j >= 0; j--) {
      const o = events[j];
      if (o.direction !== 'out' || claimedBy.has(o.id)) continue;
      if (o.ts < e.ts || o.ts - e.ts > 180) continue;
      if (e.sender_id && o.sender_id && o.sender_id !== e.sender_id) continue;
      claimedBy.set(o.id, e.id);
      outs.push(o);
    }
    outsFor.set(e.id, outs.reverse());
  }
  const rows: Row[] = [];
  for (const e of events) {
    if (e.direction === 'system') { rows.push({ key: `s${e.id}`, ts: e.ts, inbound: null, outs: [], system: e }); continue; }
    if (e.direction === 'in') { rows.push({ key: `i${e.id}`, ts: e.ts, inbound: e, outs: outsFor.get(e.id) ?? [], system: null }); continue; }
    if (claimedBy.has(e.id)) continue; // already shown under the message that triggered it
    rows.push({ key: `o${e.id}`, ts: e.ts, inbound: null, outs: [e], system: null });
  }
  return rows;
}

export const rowStatus = (r: Row): LogFilter => {
  // A system row can also be a webhook that arrived and matched nothing (status 'no_match') — that is not a reply.
  if (r.system) return r.system.status === 'error' ? 'error' : r.system.status === 'no_match' ? 'no_match' : 'sent';
  if (r.inbound?.status === 'error' || r.outs.some((o) => o.status === 'error' || o.error)) return 'error';
  if (r.outs.length) return 'sent';
  return 'no_match';
};

const PILL: Record<LogFilter, { label: string; cls: string }> = {
  all: { label: 'all', cls: '' },
  sent: { label: 'replied', cls: 'border-accent/40 text-accent bg-accent-soft/60' },
  no_match: { label: 'no rule matched', cls: 'text-muted' },
  error: { label: 'failed', cls: 'border-danger/40 text-danger bg-danger-soft/60' },
};

const KIND_LABEL: Record<string, string> = { dm_in: 'DM', comment_in: 'Comment', story_reply_in: 'Story reply', dm_out: 'DM', comment_reply_out: 'Comment reply' };

function Avatar({ name }: { name: string | null }) {
  const letter = (name || '?').replace(/^@/, '').slice(0, 1).toUpperCase();
  return <span className="mt-0.5 h-7 w-7 shrink-0 grid place-items-center rounded-full border border-line bg-surface-2 text-[11px] font-medium text-muted">{letter}</span>;
}

export interface ActivityLogProps {
  rules: AutomationRule[];
  /** shown in the empty state so people know the log is not broken, just quiet */
  connected: boolean;
  onSimulate?: () => void;
  className?: string;
}

export function ActivityLog({ rules, connected, onSimulate, className }: ActivityLogProps) {
  const q = useAutomationEvents(200);
  const [status, setStatus] = useState<LogFilter>('all');
  const [ruleId, setRuleId] = useState<string>('all');

  const rows = useMemo(() => buildRows(q.data ?? []), [q.data]);
  const filtered = useMemo(() => rows.filter((r) => {
    if (status !== 'all' && rowStatus(r) !== status) return false;
    if (ruleId !== 'all') {
      const id = Number(ruleId);
      const hit = r.inbound?.rule_id === id || r.outs.some((o) => o.rule_id === id);
      if (!hit) return false;
    }
    return true;
  }), [rows, status, ruleId]);

  const nameOf = (id: number | null) => (id ? rules.find((r) => r.id === id)?.name || `Rule #${id}` : null);

  if (q.isLoading && !q.data) return <Skeleton className={cn('h-40', className)} />;

  return (
    <div className={className}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-1 rounded-xl border border-line bg-surface p-1">
          {(['all', 'sent', 'no_match', 'error'] as LogFilter[]).map((f) => (
            <button key={f} onClick={() => setStatus(f)} className={cn('rounded-lg px-2.5 py-1 text-[12.5px] transition-colors', status === f ? 'bg-surface-2 border border-line text-ink' : 'text-muted hover:text-ink')}>
              {f === 'all' ? 'Everything' : f === 'sent' ? 'Replied' : f === 'no_match' ? 'No rule matched' : 'Failed'}
            </button>
          ))}
        </div>
        <select value={ruleId} onChange={(e) => setRuleId(e.target.value)} className="input !w-auto !py-1.5 text-[12.5px]" aria-label="Filter by rule">
          <option value="all">Every rule</option>
          {rules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <button onClick={() => q.refetch()} disabled={q.isFetching} className="btn btn-ghost btn-sm text-muted ml-auto"><RefreshCw size={12} className={cn(q.isFetching && 'animate-spin')} /> Refresh</button>
      </div>

      {filtered.length ? (
        <div className="card-flat divide-y divide-line">
          {filtered.map((r) => {
            const st = rowStatus(r);
            const pill = PILL[st];
            if (r.system) {
              return (
                <div key={r.key} className="flex items-start gap-3 px-4 py-3">
                  <span className="mt-0.5 h-7 w-7 shrink-0 grid place-items-center rounded-full border border-line bg-surface-2 text-muted"><Terminal size={13} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] text-ink-2 leading-relaxed">{r.system.text}</div>
                    {r.system.error && <div className="mt-0.5 text-[12px] text-danger">{r.system.error}</div>}
                  </div>
                  <span className="text-[11px] text-muted shrink-0">{fmtAgo(r.ts)}</span>
                </div>
              );
            }
            const head = r.inbound ?? r.outs[0];
            const who = head?.sender_username ? `@${head.sender_username}` : head?.sender_id ? head.sender_id : 'Someone';
            const matchedRule = nameOf(r.outs[0]?.rule_id ?? r.inbound?.rule_id ?? null);
            return (
              <div key={r.key} className="flex items-start gap-3 px-4 py-3">
                <Avatar name={head?.sender_username ?? null} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[13px] font-medium truncate max-w-[220px]">{who}</span>
                    {r.inbound && <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted">{KIND_LABEL[r.inbound.type] || r.inbound.type.replace(/_/g, ' ')}</span>}
                    <span className={cn('chip !py-[3px] !text-[11px]', pill.cls)}>{pill.label}</span>
                    {matchedRule && <span className="chip !py-[3px] !text-[11px]">{matchedRule}</span>}
                  </div>
                  {r.inbound?.text ? <div className="mt-1 text-[13px] text-ink-2 whitespace-pre-wrap break-words clamp-3">{r.inbound.text}</div> : null}
                  {r.outs.map((o) => (
                    <div key={o.id} className="mt-1.5 flex items-start gap-1.5 text-[12.5px] text-ink-2">
                      <CornerDownRight size={13} className="mt-0.5 shrink-0 text-accent" />
                      <span className="min-w-0 whitespace-pre-wrap break-words clamp-3">
                        <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted mr-1.5">{KIND_LABEL[o.type] || o.type.replace(/_/g, ' ')}</span>
                        {o.text || '(no text)'}
                      </span>
                    </div>
                  ))}
                  {!r.outs.length && st === 'no_match' && r.inbound ? (
                    <div className="mt-1 text-[12px] text-muted">No enabled rule matched this — open a rule and run Simulate with the same text to see which condition failed.</div>
                  ) : null}
                  {[r.inbound, ...r.outs].map((e) => (e?.error ? <div key={`e${e.id}`} className="mt-1 rounded-lg border border-danger/30 bg-danger-soft/50 px-2 py-1.5 text-[12px] text-danger break-words">Instagram said: {e.error}</div> : null))}
                </div>
                <span className="text-[11px] text-muted shrink-0">{fmtAgo(r.ts)}</span>
              </div>
            );
          })}
        </div>
      ) : rows.length ? (
        <Empty icon={<Inbox size={26} />} title="Nothing matches this filter" body="Switch back to Everything, or pick another rule." action={<button onClick={() => { setStatus('all'); setRuleId('all'); }} className="btn">Clear filters</button>} />
      ) : (
        <Empty
          icon={<Inbox size={26} />}
          title={connected ? 'Nothing has come in yet' : 'Connect Instagram to see activity'}
          body={connected
            ? 'Every DM, comment and story reply lands here within seconds — the message that came in, the rule that matched (or that none did), and the reply that went out with any error Instagram returned.'
            : 'Once your account is connected, every DM, comment and story reply lands here with the reply that went out.'}
          action={connected && onSimulate ? <button onClick={onSimulate} className="btn"><FlaskConical size={14} /> Simulate a message</button> : undefined}
        />
      )}
    </div>
  );
}
