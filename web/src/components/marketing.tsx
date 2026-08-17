/* Public (unauthenticated) building blocks: the light "editorial paper" wrapper, header, footer, section, pricing
   section, FAQ. Only imported by the lazy-loaded Landing / Pricing / Legal / Signup / Login pages, so none of this
   lands in the app bundle. The wrapper (`.marketing` in styles.css) pins the light tokens whatever the app theme. */
import { type ReactNode, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { MotionConfig } from 'motion/react';
import { ArrowRight, Menu, X, ChevronDown, Check } from 'lucide-react';
import type { PlanCatalogEntry } from '../lib/types';
import { cn } from '../lib/utils';
import { Logo } from './ui';
import { IntervalToggle, PricingCards, usePlansCatalog, type Interval } from './Pricing';
import { trialCardSentence } from '../lib/plans';

export const GITHUB_URL = 'https://github.com/tairqaldy/resurfly';
export const DOCS_URL = `${GITHUB_URL}/tree/main/docs`;
export const COMPANION_DOC_URL = `${GITHUB_URL}/blob/main/docs/COMPANION.md`;
export const HARVESTER_DOC_URL = `${GITHUB_URL}/blob/main/docs/HARVESTER.md`;
/** Chrome Web Store listing (env `VITE_COMPANION_URL`), falling back to the docs page ("Load unpacked"). */
export const COMPANION_URL: string = (import.meta.env.VITE_COMPANION_URL as string | undefined) || 'https://github.com/tairqaldy/resurfly/releases/latest';
export const SUPPORT_EMAIL = 'hello@resurfly.com';
/** Legal pages are served by the app itself (Paddle and Meta both need them on the domain). */
export const PRIVACY_URL = '/privacy';

/** lucide dropped brand icons; a plain GitHub mark for the repo links. */
export function Github({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

/* ---------------- Page wrapper ---------------- */
/** Light editorial paper for every public page, independent of the app's dark/light toggle. */
export function MarketingPage({ children, className }: { children: ReactNode; className?: string }) {
  // overflow-x-clip (not hidden): keeps the hero glow / river from widening the page without breaking the sticky header
  // reducedMotion="user": motion/react drops transform/layout animations (keeps opacity) when the OS asks for less motion
  return <MotionConfig reducedMotion="user"><div className={cn('marketing z-[1] min-h-full flex flex-col overflow-x-clip', className)}>{children}</div></MotionConfig>;
}

/* ---------------- Header / footer ---------------- */
export function PublicHeader({ active }: { active?: 'pricing' | 'login' | 'signup' | 'legal' }) {
  const [open, setOpen] = useState(false);
  const linkCls = (on?: boolean) => cn('text-[13.5px] px-2 py-1.5 rounded-lg hover:text-ink transition-colors', on ? 'text-ink' : 'text-ink-2');
  const links = (
    <>
      <Link to="/#tour" className={linkCls()}>How it works</Link>
      <Link to="/pricing" className={linkCls(active === 'pricing')}>Pricing</Link>
      <a href={DOCS_URL} target="_blank" rel="noreferrer" className={linkCls()}>Docs</a>
    </>
  );
  return (
    <header className="sticky top-0 z-40 border-b border-line/70 bg-bg/85 backdrop-blur">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 h-14 flex items-center gap-2">
        <Link to="/" className="flex items-center gap-2.5 mr-2" aria-label="Resurfly home"><Logo size={24} /><span className="display text-[20px] tracking-tight">Resurfly</span></Link>
        <nav className="hidden md:flex items-center gap-1 ml-4" aria-label="Main">{links}</nav>
        <div className="ml-auto flex items-center gap-1.5">
          <Link to="/login" className={cn('btn btn-ghost btn-sm hidden sm:inline-flex', active === 'login' && 'text-ink bg-surface-2')}>Log in</Link>
          <Link to="/signup" className="btn btn-primary btn-sm">Start free trial <ArrowRight size={13} /></Link>
          <button onClick={() => setOpen((o) => !o)} className="btn btn-ghost btn-sm !px-1.5 md:hidden" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open}>{open ? <X size={16} /> : <Menu size={16} />}</button>
        </div>
      </div>
      {open && (
        <nav className="md:hidden border-t border-line bg-bg px-4 py-3 flex flex-col gap-1" onClick={() => setOpen(false)} aria-label="Main">
          {links}
          <Link to="/login" className={linkCls(active === 'login')}>Log in</Link>
        </nav>
      )}
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-line/70 mt-16">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-10 grid gap-8 md:grid-cols-[1.5fr_1fr_1fr_1fr] text-[13px]">
        <div>
          <div className="flex items-center gap-2.5 mb-3"><Logo size={22} /><span className="display text-[18px]">Resurfly</span></div>
          <p className="text-muted leading-relaxed max-w-xs">Your Instagram saves, transcribed, summarized, tagged and searchable — plus DM automations and analytics for your own account.</p>
          <div className="mt-3 text-[11.5px] text-muted font-mono">made by one person · not affiliated with Instagram or Meta</div>
        </div>
        <FooterCol title="Product" links={[['How it works', '/#tour'], ['Pricing', '/pricing'], ['Log in', '/login'], ['Start free trial', '/signup']]} />
        <FooterCol title="Docs" links={[['Documentation', DOCS_URL], ['Companion extension', COMPANION_DOC_URL], ['One-time script', HARVESTER_DOC_URL], ['FAQ', `${GITHUB_URL}/blob/main/docs/FAQ.md`]]} />
        <FooterCol title="Legal" links={[['Privacy', '/privacy'], ['Extension privacy', '/privacy/extension'], ['Data deletion', '/data-deletion'], ['Subprocessors', '/subprocessors'], ['Security', '/security'], ['Terms', '/terms'], ['Credits', '/credits-terms'], ['Refunds', '/refunds'], ['Data processing (DPA)', '/dpa'], [`Support: ${SUPPORT_EMAIL}`, `mailto:${SUPPORT_EMAIL}`]]} />
      </div>
      <div className="mx-auto max-w-6xl px-4 sm:px-6 pb-8 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px] text-muted">
        <span>© {new Date().getFullYear()} Resurfly</span>
        <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:text-ink"><Github size={12} /> Source on GitHub · MIT</a>
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

export function Section({ id, eyebrow, title, lead, children, className, wide }: { id?: string; eyebrow?: string; title?: ReactNode; lead?: ReactNode; children: ReactNode; className?: string; wide?: boolean }) {
  return (
    <section id={id} className={cn('w-full mx-auto max-w-6xl px-4 sm:px-6 py-14 sm:py-20 scroll-mt-16', className)}>
      {(eyebrow || title) && (
        <div className={cn('mb-8 sm:mb-10', wide ? 'max-w-3xl' : 'max-w-2xl')}>
          {eyebrow && <div className="eyebrow mb-2.5">{eyebrow}</div>}
          {title && <h2 className="display text-[32px] sm:text-[42px] leading-[1.04] tracking-tight text-ink">{title}</h2>}
          {lead && <p className="mt-3.5 text-[15px] sm:text-[16px] text-ink-2 leading-relaxed">{lead}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

/* ---------------- Pricing section (landing + /pricing) ---------------- */
const NUM_WORDS: Record<number, string> = { 1: 'One', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', 14: 'Fourteen' };
export function PricingSection({ id = 'pricing', title, lead }: { id?: string; title?: ReactNode; lead?: ReactNode }) {
  const nav = useNavigate();
  const { catalog } = usePlansCatalog();
  const [interval, setInterval] = useState<Interval>('month');
  const pro = catalog.plans.find((p) => p.id === 'pro');
  const choose = (p: PlanCatalogEntry, iv: Interval) => nav(p.id === 'trial' ? '/signup' : `/signup?plan=${p.id}&interval=${iv}`);
  return (
    <Section id={id} eyebrow="Pricing" title={title ?? <>{NUM_WORDS[catalog.trialDays] ?? catalog.trialDays} days free, then <span className="text-accent">${pro?.monthly ?? 19}</span> a month.</>} lead={lead ?? `The trial analyzes your newest 100 saves and gives you 20 questions. ${trialCardSentence(catalog)} After ${catalog.trialDays} days the library stays readable and exportable; upgrade to keep analyzing.`}>
      <div className="mb-5"><IntervalToggle value={interval} onChange={setInterval} catalog={catalog} /></div>
      <PricingCards catalog={catalog} interval={interval} onChoose={choose} />
      <div className="mt-4 text-[12px] text-muted">Prices in USD. Paddle is the merchant of record and adds VAT / sales tax where it applies. Cancel any time; access runs to the end of the paid period. Every plan can export everything as JSON, CSV, Markdown or an Obsidian vault.</div>
    </Section>
  );
}

export function CostNote() {
  return (
    <div className="w-full mx-auto max-w-6xl px-4 sm:px-6">
      <div className="card p-6 sm:p-7 grid md:grid-cols-[1fr_1.4fr] gap-6">
        <div>
          <div className="eyebrow mb-2">What your money pays for</div>
          <h3 className="display text-[26px] leading-[1.1]">About $3–5 of a Pro subscription is raw cost. Here's the split.</h3>
        </div>
        <div className="text-[13.5px] text-ink-2 leading-relaxed space-y-2.5">
          <p>A Pro user costs us roughly <b>$3–5 a month</b>: OpenAI for new saves (about $0.0075 per reel) and questions (about half a cent each), object storage for thumbnails and frames (~200 KB per save), and a slice of the shared analysis workers.</p>
          <p>The first month costs more — the initial analysis of a 3,000-save library is about $22 on the standard tier — which is why the yearly plan is priced the way it is.</p>
          <p>The rest pays for the servers, keeping the importer in step with Instagram's page changes, and one person answering support. The full table is in <a className="text-accent underline underline-offset-2" href={`${GITHUB_URL}/blob/main/docs/BUSINESS.md`} target="_blank" rel="noreferrer">docs/BUSINESS.md</a>.</p>
        </div>
      </div>
    </div>
  );
}

/* ---------------- FAQ ---------------- */
export const FAQ_ITEMS: Array<{ q: string; a: ReactNode }> = [
  { q: 'Do I give you my Instagram password?', a: 'No. The Companion extension and the one-time script both run in your own logged-in browser on instagram.com and send the list of saves to Resurfly; our servers never log in to Instagram. The one exception is the optional "also sync while my browser is closed" switch in the Companion, which hands Resurfly your session, encrypted, and can be switched off at any time.' },
  { q: 'Do I need to install anything?', a: <>The Companion is a small Chrome extension (Chrome, Edge, Brave, Arc — anything Chromium). Install it, paste a pairing code from the Import page, and it syncs your saves every six hours on its own. If you would rather not install anything, the <a className="text-accent underline underline-offset-2" href={HARVESTER_DOC_URL} target="_blank" rel="noreferrer">one-time script</a> does the same job from the browser console whenever you run it.</> },
  { q: 'What if I already exported my data?', a: 'Instagram\'s "Download your information" ZIP works too: upload it under Import → Advanced. It only contains the links to your saved posts, so Resurfly fetches thumbnails and captions from each post\'s public page, best-effort, and reels cannot be transcribed from that path. The Companion or the script gives the richer import; you can run either later and existing saves are kept.' },
  { q: 'What happens when the trial ends?', a: 'Your library switches to browse-only: you can still open saves, search captions and export everything. Analysis, Ask and automations pause until you upgrade. Data is kept for 30 days after the trial ends, then it can be deleted.' },
  { q: 'Can I export my data?', a: 'Yes — JSON, CSV, a Markdown digest or an Obsidian vault, at any time on any plan, from the Library page.' },
  { q: 'Which AI models do you use?', a: 'OpenAI gpt-5.4-mini for the analysis (vision + structured JSON), gpt-4o-mini-transcribe for speech, text-embedding-3-small for meaning search. Self-hosters can point the app at any OpenAI-compatible endpoint.' },
  { q: 'Is this allowed by Instagram?', a: "You export your own data from your own logged-in browser at a human pace, read-only — the same thing every 'export my saves' tool does. Automations and analytics use Meta's official API for your own professional account. Use it on your own account and don't share your session." },
  { q: 'What is the difference between Pro and Studio?', a: 'Studio is for people who save thousands of posts and run DM automations at volume: 10,000 saves in total, 2,000 new saves a month, 1,500 questions, unlimited rules, and priority workers. Pro covers 2,000 saves and 300 new saves a month, which is most people.' },
  { q: 'Can I cancel?', a: <>Any time, from Billing → Manage subscription (Paddle portal). Access continues until the end of the paid period, and the <Link className="text-accent underline underline-offset-2" to="/refunds">refund policy</Link> covers a first purchase for 14 days. Your export still works afterwards.</> },
  { q: 'What if I want to run it myself?', a: <>The whole app is on <a className="text-accent underline underline-offset-2" href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a> under MIT. One Docker container, one OpenAI key, one volume. About $5 a month for a small server plus your own OpenAI usage (~$7.50 per 1,000 saves).</> },
];

export function FAQ({ items = FAQ_ITEMS }: { items?: typeof FAQ_ITEMS }) {
  const [openIdx, setOpenIdx] = useState<number | null>(0);
  return (
    <div className="divide-y divide-line border-y border-line">
      {items.map((it, i) => (
        <div key={it.q}>
          <button onClick={() => setOpenIdx(openIdx === i ? null : i)} className="w-full flex items-center justify-between gap-4 py-4 text-left text-[15px] font-medium hover:text-accent transition-colors rounded-md focus-visible:outline-2 focus-visible:outline-accent" aria-expanded={openIdx === i}>
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
