/* The three highest-impact actions, pinned above the report — the part a person actually does something with. */
import { motion } from 'motion/react';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { EFFORT_LABEL, type ProfileFix } from '../../lib/types-profile';
import { copyText } from '../../lib/utils';

export function NextThree({ actions }: { actions: ProfileFix[] }) {
  if (!actions.length) return null;
  return (
    <div className="card p-5 border-accent/30 bg-accent-soft/40">
      <div className="eyebrow mb-3">The next three things</div>
      <ol className="space-y-3.5">
        {actions.map((a, i) => (
          <motion.li key={`${i}-${a.what}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }} className="flex gap-3">
            <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent text-accent-ink font-mono text-[12px] tabular">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-[14px] font-medium text-ink leading-snug">{a.what}</span>
                <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted">{EFFORT_LABEL[a.effort]}</span>
              </div>
              {a.why && <div className="mt-0.5 text-[12.5px] text-ink-2 leading-relaxed">{a.why}</div>}
              {a.example && (
                <div className="mt-2 flex items-start gap-2 rounded-lg border border-line bg-surface px-2.5 py-2">
                  <span className="flex-1 whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-ink-2">{a.example}</span>
                  <button type="button" onClick={() => { void copyText(a.example ?? ''); toast.success('Copied'); }} className="btn btn-ghost btn-sm !px-1.5 shrink-0 text-muted" aria-label={`Copy the text for step ${i + 1}`}><Copy size={13} /></button>
                </div>
              )}
            </div>
          </motion.li>
        ))}
      </ol>
    </div>
  );
}
