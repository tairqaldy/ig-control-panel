/* "What a save turns into": the three REAL analyzed saves from web/public/landing/saves.json, rendered
   thumb → note (title, one-liner, key points, tags, hook, remix idea). Every string comes from the JSON. */
import { motion } from 'motion/react';
import { Play, Images, ArrowRight, Sparkles } from 'lucide-react';
import { CategoryDot } from '../ui';
import { CONTENT_TYPE_LABEL, fmtDuration, fmtNum } from '../../lib/utils';
import { useLandingJson } from './hooks';

export interface LandingSave {
  id: string; thumb: string; media_type: 'video' | 'carousel' | 'image' | string; duration: number | null;
  author: string; author_name: string | null; title: string; one_liner: string; key_points: string[]; tags: string[];
  category: string; content_type: string; hook: { text: string; style: string } | null; why_saved_guess: string | null;
  actionable_takeaways: string[]; remix_idea: string | null; usefulness_score: number | null; is_evergreen: boolean;
  summary: string | null; like_count: number | null; play_count: number | null;
}

const ease = [0.2, 0.7, 0.2, 1] as const;
const HOOK_STYLE: Record<string, string> = { bold_claim: 'bold claim', question: 'question', tutorial_promise: 'tutorial promise', story_open: 'story open', shock: 'shock', list_promise: 'list promise', relatable: 'relatable', other: 'hook' };

export function SaveShowcase() {
  const saves = useLandingJson<LandingSave[]>('/landing/saves.json', []);
  if (saves === null) return <div className="grid lg:grid-cols-3 gap-4 min-h-[520px]" aria-busy />;
  if (saves.length === 0) return null;
  return (
    <div className="grid lg:grid-cols-3 gap-4">
      {saves.slice(0, 3).map((s, i) => <SaveNote key={s.id} s={s} i={i} />)}
    </div>
  );
}

function SaveNote({ s, i }: { s: LandingSave; i: number }) {
  const kind = s.media_type === 'carousel' ? 'Carousel' : s.media_type === 'video' ? 'Reel' : 'Post';
  return (
    <motion.article initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-60px' }} transition={{ delay: i * 0.08, duration: 0.5, ease }}
      className="card p-5 sm:p-6 flex flex-col gap-4 min-w-0">
      {/* thumb → meta */}
      <div className="flex items-start gap-3.5">
        <div className="relative shrink-0 h-[110px] w-[88px] rounded-lg overflow-hidden ring-1 ring-black/10 -rotate-2 bg-[#1a1a18]" style={{ boxShadow: 'var(--shadow)' }}>
          <img src={s.thumb} alt="" width={640} height={800} loading="lazy" decoding="async" className="h-full w-full object-cover" />
          <span className="absolute left-1.5 bottom-1.5 inline-flex items-center gap-1 rounded bg-black/55 px-1 py-0.5 text-[9.5px] font-medium text-white">
            {s.media_type === 'carousel' ? <Images size={9} /> : <Play size={9} className="fill-white" />}{s.media_type === 'video' && s.duration ? fmtDuration(s.duration) : kind}
          </span>
        </div>
        <ArrowRight size={14} className="text-muted-2 shrink-0 mt-[46px]" aria-hidden />
        <div className="min-w-0">
          <div className="eyebrow !text-[10px] leading-snug flex flex-wrap items-center gap-x-1.5">
            <span>{kind}</span><span aria-hidden>·</span><span>{CONTENT_TYPE_LABEL[s.content_type] ?? s.content_type}</span><span aria-hidden>·</span><span className="normal-case tracking-normal font-sans text-[11px]">@{s.author}</span>
          </div>
          <h3 className="display mt-1.5 text-[22px] leading-[1.1] text-ink">{s.title}</h3>
          <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-muted"><CategoryDot category={s.category} /><span className="truncate">{s.category}</span></div>
        </div>
      </div>

      <p className="text-[13.5px] text-ink-2 leading-relaxed">{s.one_liner}</p>

      <div>
        <div className="eyebrow mb-1.5">Key points</div>
        <ul className="space-y-1">
          {s.key_points.map((k) => <li key={k} className="flex items-start gap-2 text-[13px] text-ink-2 leading-snug"><span className="mt-[7px] h-1 w-1 rounded-full bg-accent shrink-0" />{k}</li>)}
        </ul>
      </div>

      {s.hook?.text && (
        <div className="border-l-2 border-accent/40 pl-3">
          <div className="eyebrow mb-1">Hook <span className="text-muted-2">· {HOOK_STYLE[s.hook.style] ?? s.hook.style.replace(/_/g, ' ')}</span></div>
          <p className="display italic text-[16px] leading-[1.3] text-ink">“{s.hook.text}”</p>
        </div>
      )}

      {s.remix_idea && (
        <div className="rounded-xl bg-accent-soft/60 px-3.5 py-3">
          <div className="eyebrow mb-1 text-accent flex items-center gap-1.5"><Sparkles size={11} /> Remix idea</div>
          <p className="text-[13px] text-ink-2 leading-snug">{s.remix_idea}</p>
        </div>
      )}

      <div className="mt-auto pt-1 flex items-center gap-x-2 gap-y-1 flex-wrap text-[11px]">
        {s.tags.map((t) => <span key={t} className="font-mono text-muted">#{t}</span>)}
        <span className="ml-auto inline-flex items-center gap-2 font-mono text-[10px] text-muted">
          {s.play_count ? <span className="tabular">{fmtNum(s.play_count)} plays</span> : s.like_count ? <span className="tabular">{fmtNum(s.like_count)} likes</span> : null}
          {s.usefulness_score != null && <span className="text-accent" title="Usefulness score">{s.usefulness_score}/10</span>}
        </span>
      </div>
    </motion.article>
  );
}
