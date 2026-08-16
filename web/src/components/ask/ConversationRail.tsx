import { useMemo, useState } from 'react';
import { Pin, PinOff, Trash2, Plus, Search, MessageSquareText, Pencil, X, PanelLeftClose } from 'lucide-react';
import type { Conversation } from '../../lib/types-ask';
import { cn, fmtAgo } from '../../lib/utils';
import { Skeleton } from '../ui';

export interface RailProps {
  conversations: Conversation[];
  loading: boolean;
  supported: boolean;
  activeId: number | null;
  onSelect: (id: number) => void;
  onNew: () => void;
  onPin: (c: Conversation) => void;
  onDelete: (c: Conversation) => void;
  onRename: (c: Conversation, title: string) => void;
  onCollapse?: () => void;
  onClose?: () => void;
  className?: string;
}

function dayBucket(t: number): 'today' | 'week' | 'earlier' {
  const d = (Date.now() / 1000 - t) / 86400;
  return d < 1 ? 'today' : d < 7 ? 'week' : 'earlier';
}
const BUCKET_LABEL = { pinned: 'Pinned', today: 'Today', week: 'This week', earlier: 'Earlier' } as const;

function Row({ c, active, onSelect, onPin, onDelete, onRename }: { c: Conversation; active: boolean; onSelect: () => void; onPin: () => void; onDelete: () => void; onRename: (t: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.title);
  const commit = () => { setEditing(false); const t = draft.trim(); if (t && t !== c.title) onRename(t); else setDraft(c.title); };
  return (
    <div className={cn('group relative flex items-center gap-1 rounded-xl border px-2 py-1.5 text-[13px] transition-colors', active ? 'border-line bg-surface text-ink' : 'border-transparent text-ink-2 hover:bg-surface-2/70 hover:text-ink')} style={active ? { boxShadow: 'var(--shadow)' } : undefined}>
      {editing ? (
        <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(c.title); setEditing(false); } }} className="input !rounded-lg !px-2 !py-1 !text-[13px]" aria-label="Conversation title" />
      ) : (
        <button type="button" onClick={onSelect} onDoubleClick={() => { setDraft(c.title); setEditing(true); }} className="flex min-w-0 flex-1 flex-col text-left" title={`${c.title} · ${c.messageCount} message${c.messageCount === 1 ? '' : 's'}`}>
          <span className="truncate leading-snug">{c.title || 'Untitled'}</span>
          <span className="truncate text-[10.5px] text-muted">{fmtAgo(c.updatedAt)}{c.messageCount ? ` · ${c.messageCount} msg` : ''}</span>
        </button>
      )}
      {!editing && (
        <div className={cn('flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100', (active || c.pinned) && 'opacity-100')}>
          <button type="button" onClick={onPin} className={cn('btn btn-ghost btn-sm !px-1.5', c.pinned ? 'text-accent' : 'text-muted')} title={c.pinned ? 'Unpin' : 'Pin'} aria-label={c.pinned ? 'Unpin conversation' : 'Pin conversation'}>{c.pinned ? <PinOff size={12} /> : <Pin size={12} />}</button>
          <button type="button" onClick={() => { setDraft(c.title); setEditing(true); }} className="btn btn-ghost btn-sm !px-1.5 text-muted" title="Rename" aria-label="Rename conversation"><Pencil size={12} /></button>
          <button type="button" onClick={onDelete} className="btn btn-ghost btn-sm !px-1.5 text-muted hover:text-danger" title="Delete" aria-label="Delete conversation"><Trash2 size={12} /></button>
        </div>
      )}
    </div>
  );
}

/** Left rail: search, new, grouped conversations (Pinned / Today / This week / Earlier). Same component in the desktop column and the mobile sheet. */
export function ConversationRail({ conversations, loading, supported, activeId, onSelect, onNew, onPin, onDelete, onRename, onCollapse, onClose, className }: RailProps) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? conversations.filter((c) => c.title.toLowerCase().includes(needle)) : conversations;
    const g: Record<'pinned' | 'today' | 'week' | 'earlier', Conversation[]> = { pinned: [], today: [], week: [], earlier: [] };
    for (const c of list) (c.pinned ? g.pinned : g[dayBucket(c.updatedAt)]).push(c);
    return g;
  }, [conversations, q]);
  const empty = !loading && conversations.length === 0;
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="mb-2 flex items-center gap-1.5">
        <button type="button" onClick={onNew} className="btn btn-sm flex-1 justify-start"><Plus size={13} /> New conversation</button>
        {onCollapse && <button type="button" onClick={onCollapse} className="btn btn-ghost btn-sm !px-1.5 text-muted" title="Hide conversations" aria-label="Hide conversations"><PanelLeftClose size={14} /></button>}
        {onClose && <button type="button" onClick={onClose} className="btn btn-ghost btn-sm !px-1.5 text-muted" title="Close" aria-label="Close"><X size={14} /></button>}
      </div>
      <label className="relative mb-2 block">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations" className="input !rounded-lg !py-1.5 !pl-8 !text-[12.5px]" aria-label="Search conversations" />
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
        {loading ? (
          <div className="space-y-1.5 pt-1">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : !supported ? (
          <div className="px-2 pt-2 text-[12px] leading-relaxed text-muted">Saved conversations arrive with the next server update. Until then, this chat lives in this tab.</div>
        ) : empty ? (
          <div className="flex flex-col items-start gap-2 px-2 pt-3 text-[12px] leading-relaxed text-muted">
            <MessageSquareText size={16} className="text-muted-2" />
            <span>No conversations yet. Ask something and it lands here — pin the ones you come back to.</span>
          </div>
        ) : (
          (['pinned', 'today', 'week', 'earlier'] as const).map((k) => groups[k].length ? (
            <div key={k} className="mb-3">
              <div className="eyebrow mb-1 px-2">{BUCKET_LABEL[k]}</div>
              <div className="space-y-0.5">
                {groups[k].map((c) => <Row key={c.id} c={c} active={c.id === activeId} onSelect={() => onSelect(c.id)} onPin={() => onPin(c)} onDelete={() => onDelete(c)} onRename={(t) => onRename(c, t)} />)}
              </div>
            </div>
          ) : null)
        )}
        {!loading && supported && conversations.length > 0 && q && Object.values(groups).every((g) => g.length === 0) && <div className="px-2 pt-2 text-[12px] text-muted">Nothing matches “{q}”.</div>}
      </div>
    </div>
  );
}
