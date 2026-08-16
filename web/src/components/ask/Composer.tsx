import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Send, Square, MessageSquareText, Clapperboard, PieChart, BarChart3, type LucideIcon } from 'lucide-react';
import type { AskMode } from '../../lib/types-ask';
import { MODE_HINT, MODE_LABEL } from '../../lib/ask';
import { cn } from '../../lib/utils';

const MODES: Array<{ id: AskMode; icon: LucideIcon }> = [
  { id: 'library', icon: MessageSquareText },
  { id: 'create', icon: Clapperboard },
  { id: 'stats', icon: PieChart },
  { id: 'analytics', icon: BarChart3 },
];

const PLACEHOLDER: Record<AskMode, string> = {
  library: 'Ask about anything you saved… “what did I save about cold email?”',
  create: 'What do you want to make? “a reel about my morning routine, based on what I saved”',
  stats: '“What do I save most?” · “which creators shape my taste?” · “how has it changed this year?”',
  analytics: '“What should I post this week?” · “when do my followers actually engage?”',
};

export interface ComposerHandle { focus: () => void; }

/** Mode chip with an instant hover/focus tooltip (native `title` is too slow to explain a mode). */
function ModeChip({ id, icon: Icon, active, onPick }: { id: AskMode; icon: LucideIcon; active: boolean; onPick: () => void }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-flex">
      <button type="button" onClick={onPick} onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)} onFocus={() => setShow(true)} onBlur={() => setShow(false)} aria-pressed={active} aria-describedby={show ? `mode-tip-${id}` : undefined} className={cn('chip', active && 'chip-active')}>
        <Icon size={12} /> {MODE_LABEL[id]}
      </button>
      <AnimatePresence>
        {show && (
          <motion.span key="tip" id={`mode-tip-${id}`} role="tooltip" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.12 }} className="pointer-events-none absolute bottom-full left-0 z-20 mb-1.5 w-max max-w-[260px] rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[11.5px] leading-snug text-ink-2 whitespace-normal" style={{ boxShadow: 'var(--shadow-lg)' }}>
            {MODE_HINT[id]}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

/**
 * The composer: mode chips (with a hover explanation) + quota pill on one line, then the textarea.
 * Enter sends, Shift+Enter is a newline, ↑ recalls the last question, Esc stops a running answer.
 * `compact` centres the chips for the empty state.
 */
export const Composer = forwardRef<ComposerHandle, {
  value: string; onChange: (v: string) => void; onSend: () => void; onStop: () => void;
  busy: boolean; disabled?: boolean; mode: AskMode; onMode: (m: AskMode) => void;
  lastQuestion?: string | null; meter?: ReactNode; compact?: boolean;
}>(function Composer({ value, onChange, onSend, onStop, busy, disabled, mode, onMode, lastQuestion, meter, compact }, ref) {
  const ta = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => { ta.current?.focus(); } }), []);
  // autosize
  // (empty → natural one-row height; Chrome counts a wrapped placeholder in scrollHeight, so don't measure then)
  useEffect(() => { const el = ta.current; if (!el) return; if (!value) { el.style.height = ''; return; } el.style.height = 'auto'; el.style.height = `${Math.min(200, el.scrollHeight)}px`; }, [value]);
  const canSend = !!value.trim() && !disabled && !busy;
  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className={cn('mb-2 flex flex-wrap items-center gap-1.5', compact && 'justify-center')}>
        {MODES.map((m) => <ModeChip key={m.id} id={m.id} icon={m.icon} active={mode === m.id} onPick={() => onMode(m.id)} />)}
        {meter && <span className={cn('ml-auto', compact && 'basis-full flex justify-center sm:basis-auto sm:ml-auto')}>{meter}</span>}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); if (canSend) onSend(); }} className={cn('flex items-end gap-2 rounded-2xl border bg-surface p-2 transition-all focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/10', disabled ? 'border-line opacity-70' : 'border-line')} style={{ boxShadow: 'var(--shadow-lg)' }}>
        <textarea
          ref={ta}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (canSend) onSend(); }
            else if (e.key === 'ArrowUp' && !value && lastQuestion) { e.preventDefault(); onChange(lastQuestion); }
            else if (e.key === 'Escape' && busy) { e.preventDefault(); onStop(); }
          }}
          rows={1}
          disabled={disabled}
          placeholder={disabled ? 'Ask is paused until an OpenAI key is set' : PLACEHOLDER[mode]}
          className="max-h-[200px] flex-1 resize-none bg-transparent px-2.5 py-2 text-[14px] outline-none placeholder:text-muted-2 disabled:cursor-not-allowed"
          aria-label="Your question"
        />
        <AnimatePresence mode="wait" initial={false}>
          {busy ? (
            <motion.button key="stop" type="button" onClick={onStop} initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} transition={{ duration: 0.12 }} className="btn !rounded-xl" title="Stop (Esc)"><Square size={13} className="fill-current" /> Stop</motion.button>
          ) : (
            <motion.button key="send" type="submit" disabled={!canSend} initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} transition={{ duration: 0.12 }} className="btn btn-primary !rounded-xl" title="Send (Enter)"><Send size={14} /> Ask</motion.button>
          )}
        </AnimatePresence>
      </form>
      <div className="mt-1.5 hidden items-center justify-between gap-3 px-1 text-[11px] text-muted sm:flex">
        <span className="min-w-0 truncate">{MODE_HINT[mode]}</span>
        <span className="shrink-0"><kbd className="kbd">Enter</kbd> to send · <kbd className="kbd">Shift</kbd>+<kbd className="kbd">Enter</kbd> for a new line{busy ? <> · <kbd className="kbd">Esc</kbd> to stop</> : null}</span>
      </div>
    </div>
  );
});
