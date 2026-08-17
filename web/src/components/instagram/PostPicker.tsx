/* Round 6 §2 — pick the actual reels/posts a comment rule watches.
   GET /api/instagram/media; an older server answers 404 and the picker degrades to "every post". */
import { useMemo, useState } from 'react';
import { Check, Film, Images, ImageOff, Layers, MessageCircle, Search } from 'lucide-react';
import type { IgMediaItem } from '../../lib/types-automations';
import { Skeleton } from '../ui';
import { cn, fmtDate, fmtNum } from '../../lib/utils';
import { useIgMedia } from './useAutomations';

function Thumb({ m }: { m: IgMediaItem }) {
  const [broken, setBroken] = useState(false);
  const isReel = (m.productType || '').toUpperCase() === 'REELS' || (m.type || '').toUpperCase() === 'VIDEO';
  const isAlbum = (m.type || '').toUpperCase() === 'CAROUSEL_ALBUM';
  if (!m.thumb || broken) {
    return (
      <span className="absolute inset-0 grid place-items-center bg-surface-2 text-muted-2">
        {isReel ? <Film size={18} /> : isAlbum ? <Layers size={18} /> : <ImageOff size={18} />}
      </span>
    );
  }
  return <img src={m.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="absolute inset-0 h-full w-full object-cover" />;
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
  const media = q.data?.media ?? [];

  const list = useMemo(() => {
    const t = term.trim().toLowerCase();
    if (!t) return media;
    return media.filter((m) => (m.caption || '').toLowerCase().includes(t) || m.id.includes(t));
  }, [media, term]);

  const selected = new Set(value);
  const toggle = (id: string) => onChange(selected.has(id) ? value.filter((x) => x !== id) : [...value, id]);

  if (q.isLoading) return <div className={cn('grid grid-cols-2 sm:grid-cols-4 gap-2', className)}>{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-square" />)}</div>;

  if (q.data?.unavailable) {
    return (
      <div className={cn('rounded-xl border border-dashed border-line bg-surface-2/60 p-4 text-[12.5px] text-muted leading-relaxed', className)}>
        This server cannot list your posts yet, so the rule watches <b className="text-ink-2">every post</b>. Update Resurfly to pick individual reels.
      </div>
    );
  }
  if (!media.length) {
    return (
      <div className={cn('rounded-xl border border-dashed border-line bg-surface-2/60 p-4 text-[12.5px] text-muted leading-relaxed', className)}>
        No posts came back from Instagram, so the rule watches <b className="text-ink-2">every post</b>. Connect the account (or post something) and open this picker again.
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2 mb-2.5">
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

      <div className="max-h-[340px] overflow-y-auto rounded-xl border border-line bg-surface-2/40 p-2">
        {list.length ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-2">
            {list.map((m) => {
              const on = selected.has(m.id);
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
                      {(m.productType || '').toUpperCase() === 'REELS' ? <Film size={10} /> : (m.type || '').toUpperCase() === 'CAROUSEL_ALBUM' ? <Layers size={10} /> : null}
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
          <div className="px-3 py-8 text-center text-[12.5px] text-muted">No post caption contains “{term}”.</div>
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
