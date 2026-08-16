/* Reel river: two rows of real thumbnails (web/public/landing/reels/*.jpg, listed in reels.json) drifting in
   opposite directions. A few cards flip on a timer into the note Resurfly wrote about them (title + tags from
   the same JSON — nothing invented). CSS keyframes do the drift; hover pauses; reduced motion → static rows
   with a couple of cards already flipped so the idea still reads. */
import { useEffect, useMemo, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { Play, Images } from 'lucide-react';
import { CategoryDot } from '../ui';
import { cn } from '../../lib/utils';
import { useLandingJson } from './hooks';

export interface Reel { file: string; id: string; type: 'video' | 'carousel' | 'image' | string; category: string; title: string; tags: string[] }

const CARD_W = 360, CARD_H = 450; // intrinsic size of the JPEGs; rendered at 132×165 / 160×200
const FLIP_EVERY_MS = 2400, FLIP_FOR_MS = 4600, MAX_FLIPPED = 3;

export function ReelRiver({ className }: { className?: string }) {
  const reels = useLandingJson<Reel[]>('/landing/reels.json', []);
  const rows = useMemo(() => {
    if (!reels || reels.length === 0) return null;
    const half = Math.ceil(reels.length / 2);
    return [reels.slice(0, half), reels.slice(half)];
  }, [reels]);
  // Reserve the height even before reels.json arrives so nothing below jumps.
  return (
    <div role="group" className={cn('space-y-3', className)} aria-label="Real saved posts from the founder's library, some flipped to the note Resurfly wrote about them">
      {rows ? (
        <>
          <Row reels={rows[0]} dir="left" seed={2} />
          <Row reels={rows[1]} dir="right" seed={5} />
        </>
      ) : (
        <>
          <div className="h-[165px] sm:h-[200px]" />
          <div className="h-[165px] sm:h-[200px]" />
        </>
      )}
    </div>
  );
}

function Row({ reels, dir, seed }: { reels: Reel[]; dir: 'left' | 'right'; seed: number }) {
  const reduced = useReducedMotion();
  const [flipped, setFlipped] = useState<number[]>([]);

  useEffect(() => {
    if (reels.length < 4) return;
    if (reduced) { setFlipped([seed % reels.length, (seed + 7) % reels.length]); return; }
    let i = seed;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const iv = setInterval(() => {
      // walk the row with a stride that visits every card, skipping the ones already flipped
      i = (i + 7) % reels.length;
      setFlipped((cur) => {
        if (cur.length >= MAX_FLIPPED || cur.includes(i)) return cur;
        const idx = i;
        const t = setTimeout(() => { setFlipped((c) => c.filter((x) => x !== idx)); timers.delete(t); }, FLIP_FOR_MS);
        timers.add(t);
        return [...cur, idx];
      });
    }, FLIP_EVERY_MS);
    return () => { clearInterval(iv); timers.forEach(clearTimeout); };
  }, [reduced, reels.length, seed]);

  // ~80 s per loop on desktop; a touch faster on the second row so the two rows never look locked together
  const dur = dir === 'left' ? '84s' : '92s';
  const copy = (k: number) => (
    <div className="mk-river-copy" aria-hidden={k === 1}>
      {reels.map((r, idx) => <Card key={`${k}-${r.id}`} reel={r} flipped={flipped.includes(idx)} />)}
    </div>
  );
  return (
    <div className="mk-river">
      <div className="mk-river-track" data-dir={dir} style={{ ['--mk-dur' as string]: dur }}>
        {copy(0)}
        {copy(1)}
      </div>
    </div>
  );
}

function Card({ reel, flipped }: { reel: Reel; flipped: boolean }) {
  return (
    <div className="mk-flip h-[165px] w-[132px] sm:h-[200px] sm:w-[160px] shrink-0" data-flipped={flipped}>
      {/* front: the real thumbnail */}
      <div className="absolute inset-0 overflow-hidden rounded-xl bg-[#1a1a18] ring-1 ring-black/10">
        <img src={reel.file} alt="" width={CARD_W} height={CARD_H} loading="lazy" decoding="async" className="h-full w-full object-cover" draggable={false} onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
        <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/45 to-transparent" />
        <span className="absolute left-2 bottom-2 inline-flex items-center gap-1 rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">
          {reel.type === 'carousel' ? <Images size={10} /> : reel.type === 'video' ? <Play size={10} className="fill-white" /> : null}
          {reel.type === 'carousel' ? 'Carousel' : reel.type === 'video' ? 'Reel' : 'Post'}
        </span>
      </div>
      {/* back: the note Resurfly wrote (title + tags from reels.json) */}
      <div className="mk-flip-back overflow-hidden rounded-xl border border-line bg-surface p-2.5 flex flex-col" style={{ boxShadow: 'var(--shadow)' }}>
        <div className="flex items-center gap-1.5 text-[10px] text-muted leading-none min-w-0"><CategoryDot category={reel.category} /><span className="truncate">{reel.category}</span></div>
        <div className="display mt-1.5 text-[14px] sm:text-[15px] leading-[1.15] text-ink clamp-3">{reel.title}</div>
        <div className="mt-auto pt-1.5 flex flex-wrap gap-x-1.5 gap-y-0.5 font-mono text-[9.5px] text-muted leading-tight">
          {reel.tags.slice(0, 3).map((t) => <span key={t}>#{t}</span>)}
        </div>
      </div>
    </div>
  );
}
