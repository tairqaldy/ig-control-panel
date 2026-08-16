import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { FileText } from 'lucide-react';
import type { AskSource } from '../../lib/types-ask';
import { cn } from '../../lib/utils';

/* ---------------- Hover preview (portal, fixed position from the chip rect) ---------------- */
function HoverCard({ anchor, source, n }: { anchor: HTMLElement | null; source: AskSource; n: number }) {
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const W = 288, H = 132;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - W / 2, window.innerWidth - W - 8));
    const up = r.top > H + 16 && (window.innerHeight - r.bottom) < H + 16;
    setPos({ top: up ? r.top - 8 - H : r.bottom + 8, left, up });
  }, [anchor]);
  if (!pos || typeof document === 'undefined') return null;
  return createPortal(
    <motion.div initial={{ opacity: 0, y: pos.up ? 4 : -4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: pos.up ? 4 : -4, scale: 0.98 }} transition={{ duration: 0.14 }}
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: 288, zIndex: 90, boxShadow: 'var(--shadow-lg)' }}
      className="pointer-events-none flex gap-3 overflow-hidden rounded-xl border border-line bg-surface p-2.5">
      <div className="h-[108px] w-[80px] shrink-0 overflow-hidden rounded-lg bg-surface-2">
        {source.thumb ? <img src={source.thumb} alt="" className="h-full w-full object-cover" /> : <div className="grid h-full w-full place-items-center text-muted-2"><FileText size={16} /></div>}
      </div>
      <div className="min-w-0 flex-1 py-0.5">
        <div className="mb-1 flex items-center gap-1.5 text-[10.5px] text-muted"><span className="cite !cursor-default !mx-0">#{n}</span>{source.author ? <span className="truncate">@{source.author}</span> : source.category ? <span className="truncate">{source.category}</span> : null}</div>
        <div className="text-[12.5px] font-medium leading-snug clamp-2">{source.title || 'Untitled save'}</div>
        {source.one_liner && <div className="mt-1 text-[11.5px] leading-snug text-muted clamp-3">{source.one_liner}</div>}
      </div>
    </motion.div>,
    document.body,
  );
}

export function CitationChip({ source, n, label, onOpen }: { source?: AskSource; n: number | null; label: string; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState(false);
  const t = useRef<number | null>(null);
  const enter = () => { if (!source) return; t.current = window.setTimeout(() => setHover(true), 140); };
  const leave = () => { if (t.current) window.clearTimeout(t.current); t.current = null; setHover(false); };
  useEffect(() => () => { if (t.current) window.clearTimeout(t.current); }, []);
  return (
    <>
      <button ref={ref} type="button" onClick={onOpen} onMouseEnter={enter} onMouseLeave={leave} onFocus={enter} onBlur={leave} className={cn('cite', !source && 'opacity-60')} title={source ? `Open “${source.title}”` : `Source ${label} is not in this answer's list`} aria-label={source ? `Open source ${n}: ${source.title}` : `Source ${label}`}>{n ? `#${n}` : label}</button>
      <AnimatePresence>{hover && source && n && <HoverCard anchor={ref.current} source={source} n={n} />}</AnimatePresence>
    </>
  );
}

/* ---------------- Markdown-ish renderer ---------------- */
/** Resolve a `[#token]` citation to a source: by id first, then by 1-based index (the round-5 prompt may cite `[#3]`). */
export function resolveCitation(token: string, sources: AskSource[]): { source?: AskSource; n: number | null } {
  const byId = sources.findIndex((s) => s.id === token);
  if (byId >= 0) return { source: sources[byId], n: byId + 1 };
  if (/^\d+$/.test(token)) { const i = Number(token); if (i >= 1 && i <= sources.length) return { source: sources[i - 1], n: i }; }
  return { source: undefined, n: null };
}

const INLINE_RE = /(\[#[A-Za-z0-9_-]+\]|\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/**
 * Renders the assistant text: headings, bullet/numbered lists, paragraphs, **bold**, `code`, [text](url), bare URLs
 * and `[#id]` citations as chips (click → item modal, hover → preview). No HTML injection (everything is React text).
 * `streaming` appends a caret to the last line.
 */
export function Answer({ text, sources, onCite, streaming, className }: { text: string; sources: AskSource[]; onCite: (id: string) => void; streaming?: boolean; className?: string }) {
  const nodes = useMemo(() => {
    const lines = text.split('\n');
    const lastNonEmpty = (() => { for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return i; return -1; })();
    const renderInline = (s: string, key: number): ReactNode[] => {
      const parts: ReactNode[] = [];
      let last = 0; let m: RegExpExecArray | null; let k = 0;
      INLINE_RE.lastIndex = 0;
      while ((m = INLINE_RE.exec(s))) {
        if (m.index > last) parts.push(s.slice(last, m.index));
        const tok = m[0];
        if (tok.startsWith('[#')) {
          const id = tok.slice(2, -1);
          const { source, n } = resolveCitation(id, sources);
          parts.push(<CitationChip key={`${key}-${k++}`} source={source} n={n} label={`#${id.slice(0, 6)}`} onOpen={() => onCite(source?.id ?? id)} />);
        } else if (tok.startsWith('**')) parts.push(<strong key={`${key}-${k++}`}>{tok.slice(2, -2)}</strong>);
        else if (tok.startsWith('`')) parts.push(<code key={`${key}-${k++}`}>{tok.slice(1, -1)}</code>);
        else if (tok.startsWith('[')) { const close = tok.indexOf(']('); parts.push(<a key={`${key}-${k++}`} href={tok.slice(close + 2, -1)} target="_blank" rel="noreferrer" className="underline decoration-line-2 underline-offset-2 hover:text-accent">{tok.slice(1, close)}</a>); }
        else parts.push(<a key={`${key}-${k++}`} href={tok} target="_blank" rel="noreferrer" className="underline decoration-line-2 underline-offset-2 hover:text-accent break-all">{tok.replace(/^https?:\/\//, '')}</a>);
        last = m.index + tok.length;
      }
      if (last < s.length) parts.push(s.slice(last));
      if (streaming && key === lastNonEmpty) parts.push(<span key="caret" className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] bg-accent animate-pulse" aria-hidden />);
      return parts;
    };
    const out: ReactNode[] = [];
    let list: ReactNode[] = []; let listType: 'ul' | 'ol' | null = null;
    const flush = () => { if (list.length) { out.push(listType === 'ol' ? <ol key={`l${out.length}`}>{list}</ol> : <ul key={`l${out.length}`}>{list}</ul>); list = []; listType = null; } };
    lines.forEach((ln, i) => {
      const h = ln.match(/^(#{1,4})\s+(.*)/);
      const ul = ln.match(/^\s*[-•*]\s+(.*)/);
      const ol = ln.match(/^\s*\d+[.)]\s+(.*)/);
      const quote = ln.match(/^\s*>\s?(.*)/);
      if (h) { flush(); out.push(<h3 key={i}>{renderInline(h[2], i)}</h3>); }
      else if (ul) { if (listType && listType !== 'ul') flush(); listType = 'ul'; list.push(<li key={i}>{renderInline(ul[1], i)}</li>); }
      else if (ol) { if (listType && listType !== 'ol') flush(); listType = 'ol'; list.push(<li key={i}>{renderInline(ol[1], i)}</li>); }
      else if (quote) { flush(); out.push(<blockquote key={i} className="my-2 border-l-2 border-accent/50 pl-3 text-ink-2 italic">{renderInline(quote[1], i)}</blockquote>); }
      else if (/^\s*(---|\*\*\*)\s*$/.test(ln)) { flush(); out.push(<hr key={i} className="my-3 border-line" />); }
      else if (!ln.trim()) { flush(); }
      else { flush(); out.push(<p key={i}>{renderInline(ln, i)}</p>); }
    });
    flush();
    if (streaming && lastNonEmpty < 0) out.push(<span key="caret0" className="inline-block h-[1em] w-[2px] bg-accent animate-pulse" aria-hidden />);
    return out;
  }, [text, sources, streaming, onCite]);
  return <div className={cn('prose-rs text-[14px]', className)}>{nodes}</div>;
}
