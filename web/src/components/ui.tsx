import { type ReactNode, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';
import { cn } from '../lib/utils';

export function Logo({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
      <rect width="64" height="64" rx="16" className="fill-ink" />
      <path d="M14 42c6-12 12-18 18-18s12 6 18 18" fill="none" className="stroke-accent" strokeWidth="5" strokeLinecap="round" />
      <circle cx="32" cy="24" r="4.5" className="fill-bg" />
      <path d="M12 50h40" className="stroke-bg" strokeWidth="3" strokeLinecap="round" opacity=".7" />
    </svg>
  );
}

export function PageHeader({ eyebrow, title, subtitle, actions }: { eyebrow?: string; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-6 rise">
      <div>
        {eyebrow && <div className="eyebrow mb-1.5">{eyebrow}</div>}
        <h1 className="display text-[34px] leading-[1.05] text-ink">{title}</h1>
        {subtitle && <p className="mt-2 text-[13.5px] text-muted max-w-2xl leading-relaxed">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, accent }: { label: string; value: ReactNode; hint?: ReactNode; accent?: boolean }) {
  return (
    <div className="card p-4 flex flex-col gap-1 min-w-0">
      <div className="eyebrow">{label}</div>
      <div className={cn('display text-[30px] leading-none tabular', accent && 'text-accent')}>{value}</div>
      {hint && <div className="text-[12px] text-muted mt-1 truncate">{hint}</div>}
    </div>
  );
}

export function Empty({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card-flat border-dashed p-10 text-center flex flex-col items-center gap-3 rise">
      {icon && <div className="text-muted">{icon}</div>}
      <div className="display text-[22px]">{title}</div>
      {body && <div className="text-[13px] text-muted max-w-md leading-relaxed">{body}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cn('inline-block h-3.5 w-3.5 rounded-full border-2 border-line-2 border-t-accent animate-spin', className)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-lg', className)} />;
}

export function Modal({ open, onClose, children, width = 'max-w-5xl', className }: { open: boolean; onClose: () => void; children: ReactNode; width?: string; className?: string }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', h); document.body.style.overflow = prev; };
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto p-3 sm:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
          <div className="fixed inset-0 bg-ink/40 dark:bg-black/60 backdrop-blur-[3px]" onClick={onClose} />
          <motion.div
            className={cn('relative w-full my-auto bg-surface border border-line rounded-2xl', width, className)}
            style={{ boxShadow: 'var(--shadow-lg)' }}
            initial={{ opacity: 0, y: 14, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.99 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32, mass: 0.8 }}
            role="dialog" aria-modal
          >
            <button onClick={onClose} className="absolute right-3 top-3 z-10 btn btn-ghost btn-sm !px-1.5" aria-label="Close"><X size={16} /></button>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="inline-flex items-center gap-2 text-[13px] text-ink-2" aria-pressed={checked}>
      <span className={cn('relative inline-block h-5 w-9 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line-2')}>
        <span className={cn('absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-surface shadow transition-transform', checked && 'translate-x-4')} />
      </span>
      {label}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <div className="text-[12.5px] font-medium text-ink-2 mb-1.5">{label}</div>
      {children}
      {hint && <div className="text-[12px] text-muted mt-1.5 leading-relaxed">{hint}</div>}
    </label>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<{ id: T; label: ReactNode }> }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-xl border border-line bg-surface p-1">
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)} className={cn('relative px-3 py-1.5 text-[13px] rounded-lg transition-colors', value === t.id ? 'text-ink' : 'text-muted hover:text-ink')}>
          {value === t.id && <motion.span layoutId="tab-pill" className="absolute inset-0 rounded-lg bg-surface-2 border border-line" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
          <span className="relative">{t.label}</span>
        </button>
      ))}
    </div>
  );
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function useInfiniteScroll(cb: () => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!enabled || !ref.current) return;
    const el = ref.current;
    const io = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting) cb(); }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [cb, enabled]);
  return ref;
}

export function Kbd({ children }: { children: ReactNode }) { return <kbd className="kbd">{children}</kbd>; }

export function CategoryDot({ category, className }: { category: string | null | undefined; className?: string }) {
  return <span className={cn('inline-block h-2 w-2 rounded-full shrink-0', className)} style={{ background: `oklch(0.6 0.13 ${hue(category)})` }} />;
}
function hue(cat: string | null | undefined) {
  // mirror of utils.categoryHue kept small here to avoid circular import
  const m: Record<string, number> = { 'Business & Marketing': 28, 'Content Creation & Social Media': 340, 'Design & Visual Aesthetics': 280, 'Tech, AI & Tools': 210, 'Productivity & Mindset': 45, 'Money & Finance': 95, 'Health & Fitness': 160, 'Food & Recipes': 15, 'Travel & Places': 190, 'Fashion & Style': 320, 'Home & Interior': 60, 'Art & Creativity': 260, 'Music & Audio': 300, 'Photography & Video Craft': 240, 'Learning & Science': 200, 'Relationships & Communication': 355, 'Humor & Entertainment': 40, 'Personal & Sentimental': 10, Other: 0 };
  if (!cat) return 0;
  if (m[cat] !== undefined) return m[cat];
  let h = 0; for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) % 360; return h;
}
