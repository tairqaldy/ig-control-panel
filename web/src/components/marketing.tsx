/* Public (unauthenticated, hosted-only) building blocks: header, footer, pricing section, sample cards, FAQ.
   Only imported by the lazy-loaded Landing / Pricing pages, so none of this lands in the app bundle. */
import { type ReactNode, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { motion } from 'motion/react';
import { ArrowRight, Sun, Moon, Play, Images, Menu, X, ChevronDown, Check } from 'lucide-react';
import { useTheme } from '../lib/store';
import type { PlanCatalogEntry } from '../lib/types';
import { cn, categoryHue, fmtDuration, fmtNum } from '../lib/utils';
import { Logo, CategoryDot } from './ui';
import { IntervalToggle, PricingCards, usePlansCatalog, type Interval } from './Pricing';
import SAMPLE from '../lib/sample-saves.json';

export const GITHUB_URL = 'https://github.com/tairqaldy/resurfly';
export const DOCS_URL = `${GITHUB_URL}/tree/main/docs`;
export const PRIVACY_URL = `${GITHUB_URL}/blob/main/docs/PRIVACY.md`;

/** lucide dropped brand icons; a plain GitHub mark for the repo links. */
export function Github({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

/* ---------------- Header / footer ---------------- */
export function PublicHeader({ active }: { active?: 'pricing' | 'login' | 'signup' }) {
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const links = (
    <>
      <a href="/#how" className="text-[13.5px] text-ink-2 hover:text-ink px-2 py-1.5">How it works</a>
      <a href="/#open-source" className="text-[13.5px] text-ink-2 hover:text-ink px-2 py-1.5">Open source</a>
      <Link to="/pricing" className={cn('text-[13.5px] px-2 py-1.5 hover:text-ink', active === 'pricing' ? 'text-ink' : 'text-ink-2')}>Pricing</Link>
      <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="text-[13.5px] text-ink-2 hover:text-ink px-2 py-1.5 inline-flex items-center gap-1.5"><Github size={14} /> GitHub</a>
    </>
  );
  return (
    <header className="sticky top-0 z-40 border-b border-line/70 bg-bg/80 backdrop-blur">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 h-14 flex items-center gap-2">
        <Link to="/" className="flex items-center gap-2.5 mr-2"><Logo size={24} /><span className="display text-[20px] tracking-tight">Resurfly</span></Link>
        <nav className="hidden md:flex items-center gap-1 ml-4">{links}</nav>
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={toggle} className="btn btn-ghost btn-sm !px-1.5" title="Toggle theme">{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}</button>
          <Link to="/login" className={cn('btn btn-ghost btn-sm hidden sm:inline-flex', active === 'login' && 'text-ink')}>Log in</Link>
          <Link to="/signup" className="btn btn-primary btn-sm">Start free trial <ArrowRight size={13} /></Link>
          <button onClick={() => setOpen((o) => !o)} className="btn btn-ghost btn-sm !px-1.5 md:hidden" aria-label="Menu">{open ? <X size={16} /> : <Menu size={16} />}</button>
        </div>
      </div>
      {open && <div className="md:hidden border-t border-line bg-bg px-4 py-3 flex flex-col gap-1" onClick={() => setOpen(false)}>{links}<Link to="/login" className="text-[13.5px] text-ink-2 hover:text-ink px-2 py-1.5">Log in</Link></div>}
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-line/70 mt-16">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-10 grid gap-8 md:grid-cols-[1.4fr_1fr_1fr_1fr] text-[13px]">
        <div>
          <div className="flex items-center gap-2.5 mb-3"><Logo size={22} /><span className="display text-[18px]">Resurfly</span></div>
          <p className="text-muted leading-relaxed max-w-xs">Your Instagram saves, transcribed, summarized, tagged and searchable. Open source under MIT; hosted at resurfly.com if you'd rather not run servers.</p>
          <div className="mt-3 text-[11.5px] text-muted font-mono">MIT licensed · made by one person · not affiliated with Instagram or Meta</div>
        </div>
        <FooterCol title="Product" links={[['How it works', '/#how'], ['Pricing', '/pricing'], ['Log in', '/login'], ['Start free trial', '/signup']]} />
        <FooterCol title="Open source" links={[['GitHub', GITHUB_URL], ['Docs', DOCS_URL], ['Self-host guide', `${GITHUB_URL}#readme`], ['Cost & pricing math', `${GITHUB_URL}/blob/main/docs/BUSINESS.md`]]} />
        <FooterCol title="Legal" links={[['Privacy', PRIVACY_URL], ['FAQ', `${GITHUB_URL}/blob/main/docs/FAQ.md`], ['Support: hello@resurfly.com', 'mailto:hello@resurfly.com']]} />
      </div>
    </footer>
  );
}
function FooterCol({ title, links }: { title: string; links: Array<[string, string]> }) {
  return (
    <div>
      <div className="eyebrow mb-2.5">{title}</div>
      <ul className="space-y-1.5">
        {links.map(([l, href]) => <li key={l}>{href.startsWith('/') ? <Link to={href} className="text-ink-2 hover:text-ink">{l}</Link> : <a href={href} target={href.startsWith('mailto:') ? undefined : '_blank'} rel="noreferrer" className="text-ink-2 hover:text-ink">{l}</a>}</li>)}
      </ul>
    </div>
  );
}

export function Section({ id, eyebrow, title, lead, children, className }: { id?: string; eyebrow?: string; title?: ReactNode; lead?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={cn('mx-auto max-w-6xl px-4 sm:px-6 py-14 sm:py-20 scroll-mt-16', className)}>
      {(eyebrow || title) && (
        <div className="max-w-2xl mb-8 sm:mb-10">
          {eyebrow && <div className="eyebrow mb-2">{eyebrow}</div>}
          {title && <h2 className="display text-[32px] sm:text-[40px] leading-[1.05] tracking-tight">{title}</h2>}
          {lead && <p className="mt-3 text-[15px] text-ink-2 leading-relaxed">{lead}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

/* ---------------- Sample analyzed-save cards (static demo of the real ItemCard look) ---------------- */
type Sample = (typeof SAMPLE)[number];
export const SAMPLES: Sample[] = SAMPLE as Sample[];

export function DemoCard({ s, i, onCite }: { s: Sample; i: number; onCite?: number }) {
  const hue = categoryHue(s.category);
  return (
    <motion.article initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-60px' }} transition={{ delay: i * 0.08, duration: 0.45, ease: [0.2, 0.7, 0.2, 1] }}
      className="group relative flex flex-col overflow-hidden rounded-2xl border border-line bg-surface" style={{ boxShadow: 'var(--shadow)' }}>
      {/* "thumbnail": the hook rendered on a category-tinted plate, standing in for the frame */}
      <div className="relative aspect-[4/3] overflow-hidden" style={{ background: `linear-gradient(135deg, oklch(0.55 0.11 ${hue}) 0%, oklch(0.32 0.08 ${hue}) 100%)` }}>
        <div className="absolute inset-0 opacity-30" style={{ backgroundImage: 'radial-gradient(circle at 20% 20%, rgba(255,255,255,.35), transparent 40%), radial-gradient(circle at 80% 90%, rgba(0,0,0,.35), transparent 45%)' }} />
        <div className="absolute left-2 top-2 flex items-center gap-1">
          {s.media_type === 'video' ? <span className="inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white backdrop-blur"><Play size={10} className="fill-white" />{fmtDuration(s.duration) || 'Reel'}</span> : <span className="inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white backdrop-blur"><Images size={10} />Carousel</span>}
        </div>
        {onCite && <span className="absolute right-2 top-2 cite !cursor-default !bg-white/90 !text-black !border-white/60">#{onCite}</span>}
        <div className="absolute inset-0 p-4 flex items-end">
          <div className="display text-white text-[20px] leading-[1.15] drop-shadow-sm">“{s.hook}”</div>
        </div>
        <div className="absolute inset-x-0 bottom-0 p-3 pt-10 text-white text-[11px] flex items-center justify-between opacity-90 bg-gradient-to-t from-black/50 to-transparent">
          <span>@{s.author}</span>
          <span className="tabular">{s.play_count ? `${fmtNum(s.play_count)} plays` : (s as any).like_count ? `${fmtNum((s as any).like_count)} likes` : ''}</span>
        </div>
      </div>
      <div className="flex flex-col gap-2 p-4">
        <div className="text-[14.5px] font-medium leading-snug">{s.title}</div>
        <div className="text-[12.5px] text-muted leading-snug">{s.one_liner}</div>
        <ul className="mt-1 space-y-1">
          {s.key_points.map((k) => <li key={k} className="flex items-start gap-2 text-[12.5px] text-ink-2 leading-snug"><span className="mt-[7px] h-1 w-1 rounded-full bg-accent shrink-0" />{k}</li>)}
        </ul>
        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
          <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-2"><CategoryDot category={s.category} />{s.category}</span>
          {s.tags.map((t) => <span key={t} className="text-[11px] text-muted">#{t}</span>)}
          <span className="ml-auto font-mono text-[10px] text-accent" title="Usefulness score">{s.usefulness_score}/10</span>
        </div>
      </div>
    </motion.article>
  );
}

/* ---------------- Pricing section (landing + /pricing) ---------------- */
export function PricingSection({ id = 'pricing', title, lead }: { id?: string; title?: ReactNode; lead?: ReactNode }) {
  const nav = useNavigate();
  const { catalog } = usePlansCatalog();
  const [interval, setInterval] = useState<Interval>('month');
  const choose = (p: PlanCatalogEntry, iv: Interval) => nav(p.id === 'trial' ? '/signup' : `/signup?plan=${p.id}&interval=${iv}`);
  return (
    <Section id={id} eyebrow="Pricing" title={title ?? <>Three days free, then <span className="text-accent">$12</span> a month.</>} lead={lead ?? `The trial analyzes your newest 100 saves and gives you 20 questions. No card. After ${catalog.trialDays} days the library stays readable and exportable; upgrade to keep analyzing.`}>
      <div className="mb-5"><IntervalToggle value={interval} onChange={setInterval} /></div>
      <PricingCards catalog={catalog} interval={interval} onChoose={choose} />
      <div className="mt-4 text-[12px] text-muted">Prices in USD. Paddle is the merchant of record and adds VAT / sales tax where it applies. Cancel any time; access runs to the end of the paid period. Every plan can export everything as JSON, CSV, Markdown or an Obsidian vault.</div>
    </Section>
  );
}

export function CostNote() {
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <div className="card p-6 sm:p-7 grid md:grid-cols-[1fr_1.4fr] gap-6">
        <div>
          <div className="eyebrow mb-2">What your money pays for</div>
          <h3 className="display text-[26px] leading-[1.1]">About $3–5 of a Pro subscription is raw cost. Here's the split.</h3>
        </div>
        <div className="text-[13.5px] text-ink-2 leading-relaxed space-y-2.5">
          <p>A Pro user costs us roughly <b>$3–5 a month</b>: OpenAI for new saves (about $0.0075 per reel) and questions (about half a cent each), object storage for thumbnails and frames (~200 KB per save), and a slice of the shared analysis workers.</p>
          <p>The first month costs more — the initial analysis of a 3,000-save library is about $22 on the standard tier — which is why the yearly plan is priced the way it is.</p>
          <p>The rest of the $12 pays for the servers, keeping the harvester in step with Instagram's page changes, and one person answering support. The full table is in <a className="text-accent underline underline-offset-2" href={`${GITHUB_URL}/blob/main/docs/BUSINESS.md`} target="_blank" rel="noreferrer">docs/BUSINESS.md</a>.</p>
        </div>
      </div>
    </div>
  );
}

/* ---------------- FAQ ---------------- */
export const FAQ_ITEMS: Array<{ q: string; a: ReactNode }> = [
  { q: 'Do I give you my Instagram password?', a: 'No. The harvester is a bookmarklet that runs in your own logged-in browser tab on instagram.com and sends the list of saves to Resurfly. Our servers never log in to Instagram.' },
  { q: 'What happens when the trial ends?', a: 'Your library switches to browse-only: you can still open saves, search captions and export everything. Analysis, Ask and automations pause until you upgrade. Data is kept for 30 days after the trial ends, then it can be deleted.' },
  { q: 'Can I export my data?', a: 'Yes — JSON, CSV, a Markdown digest or an Obsidian vault, at any time on any plan, from the Library page.' },
  { q: 'Which AI models do you use?', a: 'OpenAI gpt-5.4-mini for the analysis (vision + structured JSON), gpt-4o-mini-transcribe for speech, text-embedding-3-small for meaning search. Self-hosters can point the app at any OpenAI-compatible endpoint.' },
  { q: 'Is this allowed by Instagram?', a: "You export your own data from your own logged-in browser at a human pace, read-only — the same thing every 'export my saves' tool does. Use it on your own account and don't share your session." },
  { q: 'What is the difference between Pro and Studio?', a: 'Studio is for people who save thousands of posts and run DM automations at volume: 10,000 saves in total, 2,000 new saves a month, 1,500 questions, unlimited rules, and priority workers. Pro covers 2,000 saves and 300 new saves a month, which is most people.' },
  { q: 'Can I cancel?', a: 'Any time, from Billing → Manage subscription (Paddle portal). Access continues until the end of the paid period. Your export still works afterwards.' },
  { q: 'What if I want to run it myself?', a: <>The whole app is on <a className="text-accent underline underline-offset-2" href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a> under MIT. One Docker container, one OpenAI key, one volume. About $5 a month for a small server plus your own OpenAI usage (~$7.50 per 1,000 saves).</> },
];

export function FAQ({ items = FAQ_ITEMS }: { items?: typeof FAQ_ITEMS }) {
  const [openIdx, setOpenIdx] = useState<number | null>(0);
  return (
    <div className="divide-y divide-line border-y border-line">
      {items.map((it, i) => (
        <div key={it.q}>
          <button onClick={() => setOpenIdx(openIdx === i ? null : i)} className="w-full flex items-center justify-between gap-4 py-4 text-left text-[15px] font-medium hover:text-accent transition-colors" aria-expanded={openIdx === i}>
            {it.q}<ChevronDown size={16} className={cn('text-muted shrink-0 transition-transform', openIdx === i && 'rotate-180')} />
          </button>
          {openIdx === i && <div className="pb-4 -mt-1 text-[13.5px] text-ink-2 leading-relaxed max-w-3xl">{it.a}</div>}
        </div>
      ))}
    </div>
  );
}

export function CheckList({ items, className }: { items: ReactNode[]; className?: string }) {
  return <ul className={cn('space-y-1.5 text-[13.5px] text-ink-2', className)}>{items.map((it, i) => <li key={i} className="flex items-start gap-2"><Check size={14} className="text-accent shrink-0 mt-[3px]" /><span>{it}</span></li>)}</ul>;
}
