import { memo } from 'react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { Copy, RefreshCw, Library as LibraryIcon, Clapperboard, AlertTriangle, Sparkles } from 'lucide-react';
import type { AskMessage } from '../../lib/types-ask';
import { INTENT_LABEL, answerToClipboard } from '../../lib/ask';
import { cn, copyText } from '../../lib/utils';
import { Answer } from './Answer';
import { SourcesDrawer } from './SourcesDrawer';

export interface MessageActions {
  openItem: (id: string) => void;
  regenerate: (m: AskMessage) => void;
  toBrief: (m: AskMessage) => void;
  showInLibrary: (m: AskMessage) => void;
  followUp: (question: string) => void;
}

const THINKING = ['Reading your library…', 'Finding the saves that fit…', 'Pulling the right saves…'];

export const UserBubble = memo(function UserBubble({ m }: { m: AskMessage }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6, scale: 0.99 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.18 }} className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-[14px] leading-relaxed text-bg sm:max-w-[75%]">{m.content}</div>
    </motion.div>
  );
});

/** "Try next:" lines at the end of an answer become clickable follow-ups; the answer body is everything before it. */
function splitTryNext(text: string): { body: string; next: string[] } {
  const m = /(^|\n)[ \t]*(\*\*)?try next:?(\*\*)?[ \t]*(\n|$)/i.exec(text);
  if (!m) return { body: text, next: [] };
  const start = m.index + m[1].length;
  const head = text.slice(0, start);
  const tail = text.slice(start).split('\n').slice(1);
  const next = tail.map((l) => l.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').replace(/^["“]|["”]$/g, '').trim()).filter((l) => l.length > 3 && l.length < 200);
  return next.length ? { body: head.trimEnd(), next: next.slice(0, 4) } : { body: text, next: [] };
}

export const AssistantMessage = memo(function AssistantMessage({ m, actions, isLast, busy }: { m: AskMessage; actions: MessageActions; isLast: boolean; busy: boolean }) {
  const streaming = !!m.streaming;
  const { body, next } = streaming ? { body: m.content, next: [] } : splitTryNext(m.content);
  const label = m.intent ? INTENT_LABEL[m.intent] : null;
  const thinking = THINKING[Math.abs(hash(m.localId)) % THINKING.length];
  const copy = async () => { await copyText(answerToClipboard(m.content, m.sources)); toast.success(m.sources.length ? 'Answer and sources copied' : 'Answer copied'); };
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="flex justify-start">
      <div className="w-full min-w-0">
        {(label || m.local) && (
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted"><Sparkles size={11} className="text-accent" /> {label}</div>
        )}
        <SourcesDrawer sources={m.sources} streaming={streaming} onOpen={actions.openItem} />
        <div className={cn('card p-4 sm:p-5', m.error && 'border-danger/30')}>
          {m.error ? (
            <div className="flex items-start gap-2.5 text-[13px]">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" />
              <div>
                <div className="text-danger">{m.error}</div>
                {m.question && !busy && isLast && <button type="button" onClick={() => actions.regenerate(m)} className="btn btn-sm mt-2"><RefreshCw size={12} /> Try again</button>}
              </div>
            </div>
          ) : m.content ? (
            <Answer text={body} sources={m.sources} onCite={actions.openItem} streaming={streaming} />
          ) : (
            <div className="flex items-center gap-2 text-[13px] text-muted"><span className="h-2 w-2 rounded-full bg-accent pulse-dot" /> {m.sources.length ? 'Writing…' : thinking}</div>
          )}
          {!streaming && !m.error && m.content && (
            <>
              {next.length > 0 && (
                <div className="mt-3 border-t border-line pt-3">
                  <div className="eyebrow mb-1.5">Try next</div>
                  <div className="flex flex-wrap gap-1.5">
                    {next.map((q) => <button key={q} type="button" onClick={() => actions.followUp(q)} disabled={busy} className="chip hover:border-accent hover:text-accent disabled:opacity-50">{q}</button>)}
                  </div>
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
                {!m.local && (
                  <>
                    <button type="button" onClick={() => actions.toBrief(m)} disabled={busy} className="btn btn-ghost btn-sm text-ink-2" title="Turn this answer into a content brief you can shoot"><Clapperboard size={12} /> Turn into a content brief</button>
                    {(m.sources.length > 0 || m.question) && <button type="button" onClick={() => actions.showInLibrary(m)} className="btn btn-ghost btn-sm text-ink-2" title="Search the Library for these"><LibraryIcon size={12} /> Show these in the Library</button>}
                  </>
                )}
                <button type="button" onClick={copy} className="btn btn-ghost btn-sm text-ink-2"><Copy size={12} /> Copy</button>
                {!m.local && isLast && m.question && <button type="button" onClick={() => actions.regenerate(m)} disabled={busy} className="btn btn-ghost btn-sm text-ink-2"><RefreshCw size={12} /> Regenerate</button>}
                {m.sources.length > 0 && <span className="ml-auto hidden text-[11px] text-muted sm:inline">Click a citation to open the save · hover for a preview</span>}
              </div>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
});

function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
