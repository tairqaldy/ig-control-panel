/* Round 7 §5 — the rules as a list of behaviours, not database rows.
   One sentence per rule ("When someone comments link on 3 posts → DM them"), an on/off switch, when it
   last fired, how many replies it sent this week, duplicate, and reordering by priority (drag or ↑/↓). */
import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowDown, ArrowUp, Clapperboard, Copy, GripVertical, Images, MessageCircle, MessageSquare, Pencil, Timer, Trash2, TriangleAlert, UserCheck } from 'lucide-react';
import { type AutomationRule, type TriggerFamily, familyOf, fmtCooldown, parseKeywords, parseMediaIds } from '../../lib/types-automations';
import { Toggle } from '../ui';
import { cn, fmtAgo } from '../../lib/utils';

const FAMILY_ICON: Record<TriggerFamily, typeof MessageCircle> = { comment: MessageCircle, dm: MessageSquare, dm_first: UserCheck, story_reply: Clapperboard };

const Em = ({ children }: { children: React.ReactNode }) => <b className="font-medium text-ink">{children}</b>;

/** The rule in one sentence, with the parts that differ between rules picked out in bold. */
function Behaviour({ r }: { r: AutomationRule }) {
  const family = familyOf(r.trigger_type);
  const kws = parseKeywords(r.keywords);
  const posts = parseMediaIds(r.media_ids).length;
  const kw = kws.length ? <Em>{kws.slice(0, 3).join(', ')}{kws.length > 3 ? ` +${kws.length - 3}` : ''}</Em> : null;
  const where = posts ? <> on <Em>{posts} post{posts === 1 ? '' : 's'}</Em></> : <> on <Em>any post</Em></>;

  const when =
    family === 'comment' ? <>someone comments {kw ?? <Em>anything</Em>}{where}</>
    : family === 'dm_first' ? <>someone messages you for the <Em>first time</Em></>
    : family === 'story_reply' ? <>someone replies to your story{kw ? <> with {kw}</> : null}</>
    : <>someone DMs you {kw ?? <Em>anything</Em>}</>;

  const then = r.public_reply_text?.trim()
    ? <>reply under the comment and <Em>DM them</Em></>
    : <><Em>DM them</Em>{r.reply_link ? ' with your link' : ''}</>;

  return <span className="text-[13.5px] leading-relaxed text-ink-2">When {when} <span className="text-muted-2">→</span> {then}</span>;
}

export interface RuleListProps {
  rules: AutomationRule[];
  /** rule id → replies that rule sent in the last 7 days, counted from the activity we have loaded */
  sendsThisWeek: Map<number, number>;
  /** the loaded log does not reach back a full week, so the counts are a floor, not a total */
  sendsPartial?: boolean;
  onEdit: (r: AutomationRule) => void;
  onToggle: (r: AutomationRule) => void;
  onDuplicate: (r: AutomationRule) => void;
  onDelete: (r: AutomationRule) => void;
  /** new order, first to run first; the page turns it into priorities */
  onReorder: (ids: number[]) => void;
  className?: string;
}

export function RuleList({ rules, sendsThisWeek, sendsPartial, onEdit, onToggle, onDuplicate, onDelete, onReorder, className }: RuleListProps) {
  const [dragId, setDragId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);
  // a row only becomes draggable while the pointer is on its handle — otherwise `draggable` would swallow
  // ordinary text selection inside the card
  const [grabId, setGrabId] = useState<number | null>(null);

  /* A mouse pointer is not implicitly captured, so pressing the handle and releasing anywhere else left the row
     armed: `draggable` stayed on and text inside that card could not be selected until the next drag. A release
     anywhere disarms it; a real drag is already under way by then, and onDragEnd clears it too. */
  useEffect(() => {
    if (grabId === null) return;
    const clear = () => setGrabId(null);
    window.addEventListener('pointerup', clear);
    window.addEventListener('pointercancel', clear);
    return () => { window.removeEventListener('pointerup', clear); window.removeEventListener('pointercancel', clear); };
  }, [grabId]);

  const ids = rules.map((r) => r.id);
  const move = (id: number, dir: -1 | 1) => {
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const next = [...ids];
    next.splice(j, 0, ...next.splice(i, 1));
    onReorder(next);
  };
  /**
   * Insert *where the indicator was*. Removing the dragged id first and inserting at the target's new index always
   lands before the target, so every downward drag came out one slot short — and dragging a row onto the one directly
   below it was a silent no-op: the highlight appeared, the list did not move, and priorities were rewritten to the
   values they already had. Dropping onto a row below now lands after it.
   */
  const drop = (targetId: number) => {
    setOverId(null);
    if (dragId === null || dragId === targetId) { setDragId(null); return; }
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    setDragId(null);
    if (from < 0 || to < 0) return;
    const next = ids.filter((x) => x !== dragId);
    const at = next.indexOf(targetId);
    next.splice(from < to ? at + 1 : at, 0, dragId);
    onReorder(next);
  };

  return (
    <div className={cn('space-y-2', className)}>
      {rules.map((r, i) => {
        const family = familyOf(r.trigger_type);
        const Icon = FAMILY_ICON[family];
        const sends = sendsThisWeek.get(r.id) ?? 0;
        const posts = parseMediaIds(r.media_ids).length;
        return (
          // motion.div claims onDragStart/onDragEnd for its own gesture system and never forwards them to the
          // DOM, so the animation sits on the wrapper and HTML5 drag-and-drop on a plain element inside it.
          <motion.div key={r.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.02 }}>
            <div
              draggable={grabId === r.id}
              onDragStart={(e) => { if (grabId !== r.id) { e.preventDefault(); return; } setDragId(r.id); }}
              onDragEnd={() => { setGrabId(null); setDragId(null); setOverId(null); }}
              onDragOver={(e) => { if (dragId !== null) { e.preventDefault(); setOverId(r.id); } }}
              onDragLeave={() => setOverId((cur) => (cur === r.id ? null : cur))}
              onDrop={(e) => { e.preventDefault(); drop(r.id); }}
              className={cn(
                'card px-3 py-3 sm:px-4 flex flex-wrap items-start gap-x-3 gap-y-2',
                !r.enabled && 'opacity-60',
                r.last_error && 'border-danger/40',
                dragId === r.id && 'opacity-40',
                overId === r.id && dragId !== null && dragId !== r.id && 'border-accent',
              )}
            >
              <span
                onPointerDown={() => setGrabId(r.id)}
                onPointerUp={() => setGrabId(null)}
                onPointerCancel={() => setGrabId(null)}
                className="mt-1 hidden shrink-0 cursor-grab text-muted-2 hover:text-muted active:cursor-grabbing sm:block"
                aria-hidden
              >
                <GripVertical size={14} />
              </span>
              <span className={cn('mt-0.5 h-7 w-7 shrink-0 grid place-items-center rounded-lg', family === 'comment' ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent')}><Icon size={14} /></span>

              <div className="min-w-[220px] flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[13.5px] font-medium">{r.name}</span>
                  {!r.enabled && <span className="chip !py-[2px] !text-[10.5px] text-muted">off</span>}
                </div>
                <div className="mt-0.5"><Behaviour r={r} /></div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
                  <span>{r.last_hit_at ? `last fired ${fmtAgo(r.last_hit_at)}` : 'never fired'}</span>
                  <span>{sendsPartial && sends > 0 ? 'at least ' : ''}{sends} {sends === 1 ? 'reply' : 'replies'} this week</span>
                  <span className="inline-flex items-center gap-1"><Timer size={10} /> {fmtCooldown(r.cooldown_minutes)}</span>
                  {r.once_per_person ? <span className="inline-flex items-center gap-1"><UserCheck size={10} /> once per person</span> : null}
                  {posts ? <span className="inline-flex items-center gap-1"><Images size={10} /> {posts} post{posts === 1 ? '' : 's'}</span> : null}
                </div>
                {r.last_error ? (
                  <div className="mt-2 rounded-lg border border-danger/30 bg-danger-soft/50 px-2.5 py-1.5 text-[12px] text-danger break-words">
                    <TriangleAlert size={11} className="mr-1 -mt-0.5 inline" />
                    Last send failed{r.last_error_at ? ` ${fmtAgo(r.last_error_at)}` : ''} — Instagram said: {r.last_error}
                  </div>
                ) : null}
              </div>

              <div className="ml-auto flex shrink-0 items-center gap-0.5">
                <Toggle checked={!!r.enabled} onChange={() => onToggle(r)} ariaLabel={`${r.name}: ${r.enabled ? 'on' : 'off'}`} />
                {/* the arrows stay on phones: HTML5 drag does not work there */}
                <span className="mx-0.5 inline-flex items-center sm:mx-1">
                  <button onClick={() => move(r.id, -1)} disabled={i === 0} className="btn btn-ghost btn-sm !px-1" aria-label={`Run ${r.name} earlier`} title="Run earlier"><ArrowUp size={13} /></button>
                  <button onClick={() => move(r.id, 1)} disabled={i === rules.length - 1} className="btn btn-ghost btn-sm !px-1" aria-label={`Run ${r.name} later`} title="Run later"><ArrowDown size={13} /></button>
                </span>
                <button onClick={() => onDuplicate(r)} className="btn btn-ghost btn-sm !px-1.5" aria-label={`Duplicate ${r.name}`} title="Duplicate"><Copy size={13} /></button>
                <button onClick={() => onEdit(r)} className="btn btn-ghost btn-sm !px-1.5" aria-label={`Edit ${r.name}`} title="Edit"><Pencil size={14} /></button>
                <button onClick={() => onDelete(r)} className="btn btn-ghost btn-sm !px-1.5 text-danger" aria-label={`Delete ${r.name}`} title="Delete"><Trash2 size={14} /></button>
              </div>
            </div>
          </motion.div>
        );
      })}
      <p className="px-1 pt-1 text-[11.5px] text-muted">Rules run top-down and the first match wins. Drag by the handle, or use the arrows, to change the order.</p>
    </div>
  );
}
