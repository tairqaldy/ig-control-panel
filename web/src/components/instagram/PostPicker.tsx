/* Round 6 §2 + Round 7 §5 — pick the actual reels/posts a comment rule watches.
   GET /api/instagram/media; an older server answers 404 and the picker degrades to "every post".
   Round 7 adds: caption search, reels/carousels/photos filter, newest / most-commented sort,
   "select all reels", and a chip row of what is chosen with an × on each. */
import { useMemo, useState } from 'react';
import { Check, Film, Images, ImageOff, Layers, MessageCircle, Search, X } from 'lucide-react';
import type { IgMediaItem } from '../../lib/types-automations';
import { Skeleton } from '../ui';
import { cn, fmtDate, fmtNum } from '../../lib/utils';
import { useIgMedia } from './useAutomations';

type Kind = 'reel' | 'carousel' | 'post';
type KindFilter = 'all' | Kind;
type Sort = 'newest' | 'commented';

/**
 * Instagram reports reels as productType REELS; older rows only carry type VIDEO, and a feed video comes back as
 * productType FEED with type VIDEO. Requiring an empty productType filed every one of those under "Photos", where
 * "Select all reels" never appeared and the thumbnail fell back to the no-image glyph. Any video is a reel here,
 * which is also what Instagram itself has done since feed videos became reels.
 */
function kindOf(m: IgMediaItem): Kind {
  const p = (m.productType || '').toUpperCase();
  const t = (m.type || '').toUpperCase();
  if (p === 'REELS' || t === 'VIDEO') return 'reel';
  if (t === 'CAROUSEL_ALBUM') return 'carousel';
  return 'post';
}

const KIND_ICON: Record<Kind, typeof Film> = { reel: Film, carousel: Layers, post: ImageOff };

function Thumb({ m, className }: { m: IgMediaItem; className?: string }) {
  const [broken, setBroken] = useState(false);
  const Icon = KIND_ICON[kindOf(m)];
  if (!m.thumb || broken) {
    return <span className={cn('absolute inset-0 grid place-items-center bg-surface-2 text-muted-2', className)}><Icon size={18} /></span>;
  }
  return <img src={m.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className={cn('absolute inset-0 h-full w-full object-cover', className)} />;
}

/** The row of chosen posts, so the selection stays visible while the grid is scrolled or filtered. */
function SelectedChips({ ids, byId, onRemove, onClear }: { ids: string[]; byId: Map<string, IgMediaItem>; onRemove: (id: string) => void; onClear: () => void }) {
  if (!ids.length) return null;
  return (
    <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
      {ids.map((id) => {
        const m = byId.get(id);
        return (
          <span key={id} className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent-soft/50 py-[3px] pl-[3px] pr-1.5 text-[11.5px] text-ink-2">
            <span className="relative h-5 w-5 shrink-0 overflow-hidden rounded-full bg-surface-2">
              {m ? <Thumb m={m} /> : <span className="absolute inset-0 grid place-items-center text-muted-2"><ImageOff size={11} /></span>}
            </span>
            <span className="max-w-[140px] truncate">{m ? (m.caption || 'No caption') : `Post ${id}`}</span>
            <button type="button" onClick={() => onRemove(id)} className="text-muted hover:text-danger" aria-label={`Remove ${m?.caption || id} from this rule`}><X size={11} /></button>
          </span>
        );
      })}
      {ids.length > 1 && <button type="button" onClick={onClear} className="text-[11.5px] text-muted underline underline-offset-2 hover:text-ink">Clear all</button>}
    </div>
  );
}

export interface PostPickerProps {
  /** selected media ids; empty = every post */
  value: string[];
  onChange: (ids: string[]) => void;
  className?: string;
}

/**
 * Grid of the account's real posts with thumbnails, multi-select, "any post" by default.
 * Two columns on phones, four to six from `sm` up.
 */
export function PostPicker({ value, onChange, className }: PostPickerProps) {
  const q = useIgMedia();
  const [term, setTerm] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [sort, setSort] = useState<Sort>('newest');
  const media = useMemo(() => q.data?.media ?? [], [q.data]);

  const byId = useMemo(() => new Map(media.map((m) => [m.id, m])), [media]);
  const counts = useMemo(() => {
    const c: Record<Kind, number> = { reel: 0, carousel: 0, post: 0 };
    for (const m of media) c[kindOf(m)]++;
    return c;
  }, [media]);

  const list = useMemo(() => {
    const t = term.trim().toLowerCase();
    const out = media.filter((m) => {
      if (kind !== 'all' && kindOf(m) !== kind) return false;
      if (!t) return true;
      return (m.caption || '').toLowerCase().includes(t) || m.id.includes(t);
    });
    out.sort((a, b) => (sort === 'commented' ? (b.comments ?? 0) - (a.comments ?? 0) : (b.timestamp ?? 0) - (a.timestamp ?? 0)));
    return out;
  }, [media, term, kind, sort]);

  const selected = new Set(value);
  const toggle = (id: string) => onChange(selected.has(id) ? value.filter((x) => x !== id) : [...value, id]);
  const addAllReels = () => {
    const reels = media.filter((m) => kindOf(m) === 'reel').map((m) => m.id);
    onChange([...value, ...reels.filter((id) => !selected.has(id))]);
  };

  if (q.isLoading) return <div className={cn('grid grid-cols-2 sm:grid-cols-4 gap-2', className)}>{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-square" />)}</div>;

  /* No thumbnails to show. The panel used to state that the rule "watches every post" and return before the chip
     row rendered — but the selection is untouched and still submitted, so a rule restricted to two post ids the
     picker can no longer display (the account was disconnected, `ig_media` was wiped) said the opposite of what it
     did, and the ids could not be cleared. Say which is true, and keep the way out. */
  if (q.data?.unavailable || !media.length) {
    const why = q.data?.unavailable
      ? 'This server cannot list your posts yet.'
      : 'No posts came back from Instagram.';
    return (
      <div className={cn('rounded-xl border border-dashed border-line bg-surface-2/60 p-4 text-[12.5px] leading-relaxed', className)}>
        {value.length ? (
          <>
            <div className="text-muted">
              {why} This rule is still restricted to <b className="text-ink-2">{value.length} post{value.length === 1 ? '' : 's'}</b> we cannot show you, so it only answers on {value.length === 1 ? 'that one' : 'those'}.
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => onChange([])} className="btn btn-sm">Watch every post instead</button>
              <span className="font-mono text-[11px] text-muted-2 break-all">{value.join(', ')}</span>
            </div>
          </>
        ) : (
          <span className="text-muted">
            {why} The rule watches <b className="text-ink-2">every post</b>.{' '}
            {q.data?.unavailable ? 'Update Resurfly to pick individual reels.' : 'Connect the account (or post something) and open this picker again.'}
          </span>
        )}
      </div>
    );
  }

  const FILTERS: Array<{ id: KindFilter; label: string; n: number }> = [
    { id: 'all', label: 'Everything', n: media.length },
    { id: 'reel', label: 'Reels', n: counts.reel },
    { id: 'carousel', label: 'Carousels', n: counts.carousel },
    { id: 'post', label: 'Photos', n: counts.post },
  ];

  return (
    <div className={className}>
      <SelectedChips ids={value} byId={byId} onRemove={(id) => onChange(value.filter((x) => x !== id))} onClear={() => onChange([])} />

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => onChange([])} className={cn('chip', !value.length && 'chip-active')} aria-pressed={!value.length}>
          <Images size={12} /> Any post
        </button>
        <span className="text-[12px] text-muted">
          {value.length ? `${value.length} post${value.length === 1 ? '' : 's'} selected` : `all ${media.length} posts`}
        </span>
        <label className="relative ml-auto min-w-[160px] flex-1 sm:flex-none sm:w-56">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-2" />
          <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search captions" className="input !py-1.5 pl-8 text-[12.5px]" />
        </label>
      </div>

      <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
        {FILTERS.filter((f) => f.id === 'all' || f.n > 0).map((f) => (
          <button key={f.id} type="button" onClick={() => setKind(f.id)} aria-pressed={kind === f.id} className={cn('chip !py-1 !text-[11.5px]', kind === f.id && 'chip-active')}>
            {f.label} <span className="font-mono text-muted-2">{f.n}</span>
          </button>
        ))}
        {counts.reel > 0 && (
          <button type="button" onClick={addAllReels} className="chip !py-1 !text-[11.5px]"><Film size={11} /> Select all {counts.reel} reels</button>
        )}
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="input ml-auto !w-auto !py-1 text-[11.5px]" aria-label="Sort posts">
          <option value="newest">Newest first</option>
          <option value="commented">Most commented</option>
        </select>
      </div>

      <div className="max-h-[340px] overflow-y-auto rounded-xl border border-line bg-surface-2/40 p-2">
        {list.length ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-2">
            {list.map((m) => {
              const on = selected.has(m.id);
              const k = kindOf(m);
              return (
                <button
                  type="button" key={m.id} onClick={() => toggle(m.id)} aria-pressed={on}
                  className={cn('group relative aspect-square overflow-hidden rounded-lg border text-left transition-all', on ? 'border-accent ring-2 ring-accent/25' : 'border-line hover:border-line-2')}
                >
                  <Thumb m={m} />
                  <span className={cn('absolute inset-0 transition-opacity', on ? 'bg-ink/35' : 'bg-ink/0 group-hover:bg-ink/20')} />
                  <span className={cn('absolute right-1.5 top-1.5 h-5 w-5 grid place-items-center rounded-full border transition-all', on ? 'bg-accent border-accent text-accent-ink' : 'border-white/70 bg-black/30 text-transparent opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100')}>
                    <Check size={12} />
                  </span>
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-1.5 pb-1 pt-4 text-[10px] text-white/90">
                    <span className="flex items-center gap-1.5 font-mono">
                      {k === 'reel' ? <Film size={10} /> : k === 'carousel' ? <Layers size={10} /> : null}
                      {m.comments != null ? <><MessageCircle size={10} />{fmtNum(m.comments)}</> : null}
                      <span className="ml-auto">{m.timestamp ? fmtDate(m.timestamp).replace(/,.*/, '') : ''}</span>
                    </span>
                    <span className="block truncate">{m.caption || 'No caption'}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="px-3 py-8 text-center text-[12.5px] text-muted">
            {term ? `No ${kind === 'all' ? 'post' : kind} caption contains “${term}”.` : 'Nothing of that kind in your last posts.'}
          </div>
        )}
      </div>
      <p className="mt-2 text-[12px] text-muted leading-relaxed">
        {value.length
          ? 'Comments on any other post are ignored by this rule.'
          : 'The rule answers comments on every post, including ones you publish later.'}
      </p>
    </div>
  );
}
