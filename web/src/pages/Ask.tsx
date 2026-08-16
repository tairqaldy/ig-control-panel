import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { Send, Sparkles, Trash2, Square, MessageSquareText, Copy, FileText } from 'lucide-react';
import { ssePost } from '../lib/api';
import type { AskSource } from '../lib/types';
import { useItemModal, useAuth } from '../lib/store';
import { PageHeader } from '../components/ui';
import { cn, copyText } from '../lib/utils';

interface Turn { role: 'user' | 'assistant'; content: string; sources?: AskSource[]; error?: string; streaming?: boolean }

const STARTERS = [
  'What are the recurring themes across everything I saved?',
  'Summarize the best hooks for reels I saved, with examples',
  'Which tools and apps did I save the most, and what were they for?',
  'Give me a step-by-step plan from my saved productivity advice',
  'What recipes did I save? List ingredients where available',
  'Which saved posts contradict each other?',
];

const STORAGE = 'rs-ask-history';

/** Render markdown-ish text with [#id] citations turned into chips. Minimal, safe (no HTML injection). */
function Answer({ text, sources, onCite }: { text: string; sources: AskSource[]; onCite: (id: string) => void }) {
  const byId = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);
  const lines = text.split('\n');
  const renderInline = (s: string, key: number) => {
    // split on citations and **bold**
    const parts: React.ReactNode[] = [];
    const re = /(\[#[A-Za-z0-9_-]+\]|\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0; let m: RegExpExecArray | null; let k = 0;
    while ((m = re.exec(s))) {
      if (m.index > last) parts.push(s.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith('[#')) {
        const id = tok.slice(2, -1);
        const src = byId.get(id);
        parts.push(<button key={`${key}-${k++}`} onClick={() => onCite(id)} className="cite" title={src?.title || id}>{src ? `#${sources.indexOf(src) + 1}` : id}</button>);
      } else if (tok.startsWith('**')) parts.push(<strong key={`${key}-${k++}`}>{tok.slice(2, -2)}</strong>);
      else parts.push(<code key={`${key}-${k++}`}>{tok.slice(1, -1)}</code>);
      last = m.index + tok.length;
    }
    if (last < s.length) parts.push(s.slice(last));
    return parts;
  };
  const out: React.ReactNode[] = [];
  let list: React.ReactNode[] = []; let listType: 'ul' | 'ol' | null = null;
  const flush = () => { if (list.length) { out.push(listType === 'ol' ? <ol key={out.length}>{list}</ol> : <ul key={out.length}>{list}</ul>); list = []; listType = null; } };
  lines.forEach((ln, i) => {
    const h = ln.match(/^(#{1,3})\s+(.*)/);
    const ul = ln.match(/^\s*[-•*]\s+(.*)/);
    const ol = ln.match(/^\s*\d+[.)]\s+(.*)/);
    if (h) { flush(); out.push(<h3 key={i}>{renderInline(h[2], i)}</h3>); }
    else if (ul) { if (listType && listType !== 'ul') flush(); listType = 'ul'; list.push(<li key={i}>{renderInline(ul[1], i)}</li>); }
    else if (ol) { if (listType && listType !== 'ol') flush(); listType = 'ol'; list.push(<li key={i}>{renderInline(ol[1], i)}</li>); }
    else if (!ln.trim()) { flush(); }
    else { flush(); out.push(<p key={i}>{renderInline(ln, i)}</p>); }
  });
  flush();
  return <div className="prose-rs text-[14px]">{out}</div>;
}

function SourceCard({ s, n, onOpen }: { s: AskSource; n: number; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="group flex w-44 shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-surface text-left hover:border-line-2 transition-colors" style={{ boxShadow: 'var(--shadow)' }}>
      <div className="relative aspect-[4/3] bg-surface-2 overflow-hidden">
        {s.thumb ? <img src={s.thumb} alt="" className="h-full w-full object-cover group-hover:scale-105 transition-transform duration-500" loading="lazy" /> : <div className="h-full w-full grid place-items-center text-muted-2"><FileText size={16} /></div>}
        <span className="absolute left-1.5 top-1.5 cite !cursor-default">#{n}</span>
      </div>
      <div className="p-2.5">
        <div className="text-[12px] font-medium leading-snug clamp-2">{s.title}</div>
        <div className="mt-0.5 text-[10.5px] text-muted truncate">{s.author ? `@${s.author}` : s.category}</div>
      </div>
    </button>
  );
}

export default function Ask() {
  const [sp, setSp] = useSearchParams();
  const modal = useItemModal();
  const auth = useAuth();
  const [turns, setTurns] = useState<Turn[]>(() => { try { return JSON.parse(sessionStorage.getItem(STORAGE) || '[]'); } catch { return []; } });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const openaiOff = auth.setupIssues.some((s) => s.includes('OPENAI'));

  useEffect(() => { sessionStorage.setItem(STORAGE, JSON.stringify(turns.map((t) => ({ ...t, streaming: false })))); }, [turns]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns.length, turns[turns.length - 1]?.content.length]);
  // Honour ?q= on mount AND whenever it changes while already on /ask ("Ask about this" from the modal, palette).
  const pendingQ = sp.get('q');
  useEffect(() => { if (pendingQ) { setSp({}, { replace: true }); void ask(pendingQ); } }, [pendingQ]);
  // Abort an in-flight answer if the user navigates away.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function ask(question: string) {
    const qn = question.trim();
    if (!qn || busy) return;
    setInput('');
    const history = turns.filter((t) => !t.error).slice(-6).map((t) => ({ role: t.role, content: t.content }));
    setTurns((t) => [...t, { role: 'user', content: qn }, { role: 'assistant', content: '', streaming: true, sources: [] }]);
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await ssePost('/api/ask', { question: qn, history }, {
        signal: ctrl.signal,
        onEvent: (ev, data) => {
          setTurns((t) => {
            const next = t.slice();
            const last = { ...next[next.length - 1] };
            if (ev === 'sources') last.sources = data as AskSource[];
            else if (ev === 'delta') last.content += String(data);
            else if (ev === 'error') { last.error = data?.message || 'Error'; last.streaming = false; }
            else if (ev === 'done') last.streaming = false;
            next[next.length - 1] = last;
            return next;
          });
        },
      });
    } catch (e: any) {
      if (e?.name !== 'AbortError') setTurns((t) => { const n = t.slice(); n[n.length - 1] = { ...n[n.length - 1], error: e?.message || 'Request failed', streaming: false }; return n; });
    } finally {
      setBusy(false);
      abortRef.current = null;
      setTurns((t) => { const n = t.slice(); if (n.length) n[n.length - 1] = { ...n[n.length - 1], streaming: false }; return n; });
    }
  }
  const stop = () => abortRef.current?.abort();
  const clear = () => { setTurns([]); sessionStorage.removeItem(STORAGE); };

  return (
    <div className="flex flex-col min-h-[calc(100vh-4rem)] lg:min-h-[calc(100vh-4rem)]">
      <PageHeader eyebrow="Ask · killer feature" title={<>Talk to everything you ever <em className="text-accent not-italic">saved</em></>} subtitle="Hybrid retrieval (meaning + keywords) over your analyzed saves, answered with citations you can click. It only knows what’s in your library — that’s the point." actions={turns.length ? <button onClick={clear} className="btn btn-sm"><Trash2 size={13} /> Clear chat</button> : undefined} />
      {openaiOff && <div className="mb-4 rounded-xl border border-warn/40 bg-warn-soft px-3 py-2 text-[12.5px]">OpenAI isn’t configured — add your key in Settings to use Ask.</div>}

      <div className="flex-1">
        {turns.length === 0 ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 rise">
            {STARTERS.map((s) => (
              <button key={s} onClick={() => ask(s)} className="card p-4 text-left text-[13.5px] hover:border-line-2 hover:-translate-y-0.5 transition-all">
                <Sparkles size={14} className="text-accent mb-2" />{s}
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-6 pb-32">
            {turns.map((t, i) => (
              <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className={cn('flex', t.role === 'user' ? 'justify-end' : 'justify-start')}>
                {t.role === 'user' ? (
                  <div className="max-w-[80%] rounded-2xl rounded-br-md bg-ink text-bg px-4 py-2.5 text-[14px] leading-relaxed">{t.content}</div>
                ) : (
                  <div className="w-full max-w-3xl">
                    {t.sources && t.sources.length > 0 && (
                      <div className="mb-3">
                        <div className="eyebrow mb-1.5">Sources · {t.sources.length}</div>
                        <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
                          {t.sources.map((s, n) => <SourceCard key={s.id} s={s} n={n + 1} onOpen={() => modal.open(s.id)} />)}
                        </div>
                      </div>
                    )}
                    <div className="card p-5">
                      {t.error ? <div className="text-[13px] text-danger">{t.error}</div> : t.content ? <Answer text={t.content} sources={t.sources || []} onCite={(id) => modal.open(id)} /> : <div className="flex items-center gap-2 text-[13px] text-muted"><span className="h-2 w-2 rounded-full bg-accent pulse-dot" /> Reading your library…</div>}
                      {t.streaming && t.content && <span className="inline-block h-4 w-1.5 bg-accent align-middle animate-pulse ml-0.5" />}
                      {!t.streaming && t.content && (
                        <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
                          <button onClick={() => { copyText(t.content); toast.success('Copied'); }} className="btn btn-ghost btn-sm text-muted"><Copy size={12} /> Copy</button>
                          <span className="text-[11px] text-muted ml-auto">Answers are grounded only in your saves. Click a citation to open the source.</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </motion.div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="sticky bottom-0 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 pt-3 pb-4 bg-gradient-to-t from-bg via-bg to-transparent">
        <form onSubmit={(e) => { e.preventDefault(); ask(input); }} className="mx-auto max-w-3xl flex items-end gap-2 rounded-2xl border border-line bg-surface p-2" style={{ boxShadow: 'var(--shadow-lg)' }}>
          <MessageSquareText size={16} className="text-muted ml-2 mb-2.5" />
          <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input); } }} rows={1} placeholder="Ask about anything you saved… (Enter to send, Shift+Enter for a new line)" className="flex-1 resize-none bg-transparent px-1 py-2 text-[14px] outline-none placeholder:text-muted-2 max-h-40" style={{ height: 'auto' }} onInput={(e) => { const el = e.currentTarget; el.style.height = 'auto'; el.style.height = `${Math.min(160, el.scrollHeight)}px`; }} />
          <AnimatePresence mode="wait">
            {busy ? (
              <motion.button key="stop" type="button" onClick={stop} initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} className="btn !rounded-xl"><Square size={14} /> Stop</motion.button>
            ) : (
              <motion.button key="send" type="submit" disabled={!input.trim() || openaiOff} initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} className="btn btn-primary !rounded-xl"><Send size={14} /> Ask</motion.button>
            )}
          </AnimatePresence>
        </form>
      </div>
    </div>
  );
}
