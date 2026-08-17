/* /privacy, /privacy/extension, /security, /terms, /refunds — the markdown documents in docs/ rendered as public
   pages (ROUND5 §8b, ROUND6 §6).
   Paddle (live) and Meta (Live mode) both need these URLs on the domain. Same header/footer as the landing. */
import { useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import { MarketingPage, PublicHeader, PublicFooter, SUPPORT_EMAIL } from '../components/marketing';
import { Markdown, markdownTitle } from '../lib/markdown';
import { cn } from '../lib/utils';
import privacy from '../../../docs/PRIVACY.md?raw';
import terms from '../../../docs/legal/TERMS.md?raw';
import refunds from '../../../docs/legal/REFUNDS.md?raw';
import extensionPrivacy from '../../../docs/legal/EXTENSION-PRIVACY.md?raw';
import security from '../../../docs/legal/SECURITY.md?raw';
import creditsTerms from '../../../docs/legal/CREDITS-TERMS.md?raw';
import dataDeletion from '../../../docs/legal/DATA-DELETION.md?raw';
import subprocessors from '../../../docs/legal/SUBPROCESSORS.md?raw';
import dpa from '../../../docs/legal/DPA.md?raw';

const DOCS = {
  '/privacy': { label: 'Privacy', source: privacy },
  '/privacy/extension': { label: 'Extension privacy', source: extensionPrivacy },
  '/data-deletion': { label: 'Data deletion', source: dataDeletion },
  '/subprocessors': { label: 'Subprocessors', source: subprocessors },
  '/security': { label: 'Security', source: security },
  '/terms': { label: 'Terms', source: terms },
  '/credits-terms': { label: 'Credits', source: creditsTerms },
  '/refunds': { label: 'Refunds', source: refunds },
  '/dpa': { label: 'Data processing', source: dpa },
} as const;
type LegalPath = keyof typeof DOCS;
/* Longest path first so /privacy/extension is not swallowed by /privacy. */
const PATHS = (Object.keys(DOCS) as LegalPath[]).sort((a, b) => b.length - a.length);

export default function Legal() {
  const { pathname } = useLocation();
  const path = PATHS.find((p) => pathname === p || pathname.startsWith(p + '/')) ?? '/privacy';
  const doc = DOCS[path];
  const title = markdownTitle(doc.source) ?? doc.label;
  useEffect(() => { document.title = `${title} — Resurfly`; window.scrollTo(0, 0); return () => { document.title = 'Resurfly'; }; }, [title, path]);
  return (
    <MarketingPage>
      <PublicHeader active="legal" />
      <main className="w-full mx-auto max-w-6xl px-4 sm:px-6 py-10 sm:py-14 grid lg:grid-cols-[200px_1fr] gap-8 lg:gap-14">
        <nav aria-label="Legal pages" className="lg:sticky lg:top-20 self-start">
          <div className="eyebrow mb-2.5">Legal</div>
          <ul className="flex lg:flex-col gap-1 flex-wrap">
            {(Object.keys(DOCS) as LegalPath[]).map((p) => (
              <li key={p}><Link to={p} className={cn('inline-block rounded-lg px-2.5 py-1.5 text-[13.5px] transition-colors', p === path ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:text-ink')} aria-current={p === path ? 'page' : undefined}>{DOCS[p].label}</Link></li>
            ))}
          </ul>
          <div className="mt-6 text-[12px] text-muted leading-relaxed hidden lg:block">Questions: <a className="underline underline-offset-2 hover:text-ink" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a></div>
        </nav>
        <article className="min-w-0 max-w-3xl">
          <Markdown source={doc.source} className="mk-prose" />
        </article>
      </main>
      <PublicFooter />
    </MarketingPage>
  );
}
