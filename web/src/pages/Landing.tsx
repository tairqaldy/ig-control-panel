/* Public landing (ROUND5 §8): light editorial paper, real assets from web/public/landing/, motion in small doses.
   Sections: hero → reel river → what a save turns into → 40-second tour → three vignettes (Ask, DM automations,
   Analytics) + Library/Graph frames → Companion → pricing → FAQ → closing CTA → footer. */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { motion } from 'motion/react';
import { ArrowRight, ArrowDown, MessageSquareText, Waypoints, Sparkles, Puzzle, Terminal, Zap, BarChart3 } from 'lucide-react';
import { MarketingPage, PublicHeader, PublicFooter, Section, PricingSection, FAQ, CheckList, COMPANION_URL, HARVESTER_DOC_URL } from '../components/marketing';
import { Frame, SHOTS } from '../components/marketing/Frame';
import { ReelRiver } from '../components/marketing/ReelRiver';
import { SaveShowcase } from '../components/marketing/SaveShowcase';
import { TourVideo } from '../components/marketing/TourVideo';
import { AskVignette } from '../components/marketing/AskVignette';
import { DmVignette } from '../components/marketing/DmVignette';
import { AnalyticsVignette } from '../components/marketing/AnalyticsVignette';
import { CompanionVignette } from '../components/marketing/CompanionVignette';
import { cn } from '../lib/utils';

const ease = [0.2, 0.7, 0.2, 1] as const;
const rise = (delay = 0) => ({ initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { delay, duration: 0.6, ease } });
const riseInView = (delay = 0) => ({ initial: { opacity: 0, y: 14 }, whileInView: { opacity: 1, y: 0 }, viewport: { once: true, margin: '-60px' }, transition: { delay, duration: 0.5, ease } });

export default function Landing() {
  const loc = useLocation();
  useEffect(() => { document.title = 'Resurfly — every reel you saved, turned into notes you can search'; return () => { document.title = 'Resurfly'; }; }, []);
  // /#tour from the header on another page: the section exists only after this lazy page mounts, so scroll by hand.
  useEffect(() => {
    if (!loc.hash) return;
    const t = setTimeout(() => document.querySelector(loc.hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    return () => clearTimeout(t);
  }, [loc.hash]);

  return (
    <MarketingPage>
      <PublicHeader />

      {/* ---------- 1. Hero ---------- */}
      <section className="w-full mx-auto max-w-6xl px-4 sm:px-6 pt-12 sm:pt-20 pb-10 sm:pb-14 grid lg:grid-cols-[1fr_1.1fr] gap-10 lg:gap-12 items-center">
        <div>
          <motion.div {...rise(0)} className="eyebrow mb-4">For anyone with a few hundred Instagram saves</motion.div>
          <motion.h1 {...rise(0.05)} className="display text-[42px] sm:text-[60px] lg:text-[64px] leading-[0.98] tracking-tight text-ink text-balance">
            Every reel you ever saved, turned into <em className="text-accent not-italic">notes you can search</em>.
          </motion.h1>
          <motion.p {...rise(0.15)} className="mt-6 text-[16px] sm:text-[17px] text-ink-2 leading-relaxed max-w-xl">
            Resurfly imports your Instagram saves, transcribes the reels and writes a title, a summary, key points and tags for each one. Then you ask a question across all of them and get an answer that cites the exact saves.
          </motion.p>
          <motion.div {...rise(0.25)} className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/signup" className="btn btn-primary py-2.5 px-5 text-[14px]">Start free trial <ArrowRight size={15} /></Link>
            <a href="#tour" className="btn py-2.5 px-4 text-[14px]">See how it works <ArrowDown size={14} className="text-muted" /></a>
          </motion.div>
          <motion.div {...rise(0.35)} className="mt-4 text-[12.5px] text-muted">Three days free · no card · your newest 100 saves analyzed</motion.div>
        </div>
        <motion.div initial={{ opacity: 0, y: 18, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ delay: 0.2, duration: 0.7, ease }} className="relative lg:-mr-6">
          <div className="absolute -inset-8 rounded-[32px] bg-accent/10 blur-3xl -z-10" aria-hidden />
          <Frame src={SHOTS.ask} alt="Resurfly's Ask page: a question about saved reels answered with citations to the exact saves" priority fallback="placeholder" />
        </motion.div>
      </section>

      {/* ---------- 2. Reel river ---------- */}
      <section className="w-full py-6 sm:py-8" aria-labelledby="river-caption">
        <ReelRiver />
        <p id="river-caption" className="mx-auto max-w-6xl px-4 sm:px-6 mt-4 text-[12.5px] text-muted">Real saves from the founder's library. The cards that flip show the note Resurfly wrote about each one.</p>
      </section>

      {/* ---------- 3. What a save turns into ---------- */}
      <Section id="notes" eyebrow="What a save turns into" title="Three saves, exactly as Resurfly analyzed them." lead="The title, one-liner, key points, hook and remix idea are written by the model from the transcript, the frames and the caption. Tags and category come from a fixed vocabulary so filters stay clean.">
        <SaveShowcase />
        <div className="mt-5 text-[12.5px] text-muted max-w-3xl">Each note also has a full summary, the transcript, on-screen text, quotes, entities (people, tools, places, brands), a "why you probably saved this" guess and three actionable takeaways. Everything is a field in your export.</div>
      </Section>

      {/* ---------- 4. Tour video ---------- */}
      <Section id="tour" eyebrow="How it works" title="See it in 40 seconds." lead="Import, the first notes arriving, a question with citations, the graph, one automation rule switched on.">
        <TourVideo />
        <ol className="mt-6 grid sm:grid-cols-3 gap-x-6 gap-y-3 text-[13.5px] text-ink-2 leading-relaxed">
          {[
            ['01', 'Bring your saves', 'Install the Companion or run the one-time script in your own browser. Instagram has no API for saves, so this part happens on your side.'],
            ['02', 'Notes arrive', 'Each save gets a transcript, four frames read by a vision model and a structured note. Runs in the background; close the tab.'],
            ['03', 'Ask, browse, resurface', 'Search by meaning, ask questions with citations, see your taste as a graph, get three old saves back each morning.'],
          ].map(([n, t, b]) => (
            <li key={n} className="flex gap-3"><span className="font-mono text-[11px] text-muted mt-1">{n}</span><div><div className="font-medium text-ink">{t}</div><div className="text-[13px] text-muted mt-0.5">{b}</div></div></li>
          ))}
        </ol>
      </Section>

      {/* ---------- 5. Feature vignettes ---------- */}
      <Section id="features" eyebrow="What you get" title="Ask across everything you saved. Then put your account to work." lead="Three things Resurfly does that a folder of bookmarks cannot." className="!pt-4">
        <div className="space-y-16 sm:space-y-24">
          <Vignette
            icon={<MessageSquareText size={12} />} eyebrow="Ask" title="Questions answered from your saves, with the receipts." shot={SHOTS.ask} shotAlt="Ask page"
            body="Type a question the way you would ask a friend who watched all your reels. The answer is built only from your saves and cites each one; click a citation to open the save. Ask also writes content briefs from your best-matching saves and, once Instagram is connected, answers questions about your own numbers."
            points={['Meaning search across transcripts, captions and notes', 'Every claim carries a citation you can open', 'Content brief mode: hook options, outline, format, why it fits your taste']}
            media={<AskVignette />}
          />
          <Vignette
            flip icon={<Zap size={12} />} eyebrow="DM automations" title="Comment “link” → the link arrives in DMs." shot={SHOTS.automations} shotAlt="Automations page"
            body="Connect your Instagram professional account and three starter rules are ready: comment keyword → DM, first DM → welcome, story reply → thanks. Edit the keywords and the reply, switch a rule on, send yourself a test. Runs on Meta's official messaging API — nothing unofficial touches your account."
            points={['One-click connect; webhooks subscribed for you', 'Keyword rules for comments, DMs and story replies', 'An activity log of every reply that went out']}
            media={<DmVignette />}
          />
          <Vignette
            icon={<BarChart3 size={12} />} eyebrow="Analytics" title="Your account's numbers, next to your saves." shot={SHOTS.analytics} shotAlt="Analytics page"
            body="Followers and reach over 7, 30 or 90 days, the best hours to post, content mix and engagement rate, top posts by saves and reach, hashtags that carried. Then one click asks: “Based on my analytics, what should I post this week?”"
            points={['Same official API as the automations; refreshed every few hours', 'Best-time-to-post from your own posting history', 'Sample data until you connect, so the page is never blank']}
            media={<AnalyticsVignette />}
          />
        </div>

        {/* Library + Graph frames (each hides itself if the shot is missing) */}
        <div className="mt-16 sm:mt-24 grid md:grid-cols-2 gap-6">
          <ShotCard src={SHOTS.library} alt="Library page with filters and search" icon={<Sparkles size={13} />} title="Library" body="Filters by category, creator, format and tag; keyword or meaning search; three old saves resurfaced each morning; export to JSON, CSV, Markdown or Obsidian." />
          <ShotCard src={SHOTS.graph} alt="Graph of tags, creators and categories" icon={<Waypoints size={13} />} title="Graph" body="Your library as a map of tags, creators and categories. Click a node to see the saves behind it — the shape of your own taste." />
        </div>
      </Section>

      {/* ---------- 6. Companion ---------- */}
      <Section id="companion" eyebrow="Companion" title="Installs in a minute, keeps your saves in sync." lead="The Companion is a small Chrome extension. Every six hours it reads your saved posts through your own logged-in browser and sends the new ones over. Nothing to run, no password to hand over — and the one-time script is still there if you would rather not install anything.">
        <div className="grid lg:grid-cols-[1fr_1.25fr] gap-8 lg:gap-12 items-center">
          <div className="min-w-0">
            <CheckList items={['Pair with a code from the Import page; valid five minutes', 'First run walks your whole saved feed; later runs stop after three pages of known saves', 'Optional: keep syncing while your browser is closed (off by default, revocable)']} />
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <a href={COMPANION_URL} target="_blank" rel="noreferrer" className="btn"><Puzzle size={14} /> Get the Companion</a>
              <a href={HARVESTER_DOC_URL} target="_blank" rel="noreferrer" className="text-[13px] text-ink-2 hover:text-ink inline-flex items-center gap-1.5"><Terminal size={13} /> or run the one-time script</a>
            </div>
          </div>
          <motion.div {...riseInView(0.05)} className="min-w-0"><CompanionVignette /></motion.div>
        </div>
      </Section>

      {/* ---------- 7. Pricing ---------- */}
      <PricingSection />

      {/* ---------- 8. FAQ ---------- */}
      <Section eyebrow="FAQ" title="Short answers.">
        <FAQ />
      </Section>

      {/* ---------- Closing CTA ---------- */}
      <section className="w-full mx-auto max-w-6xl px-4 sm:px-6 pb-4">
        <motion.div {...riseInView()} className="card p-8 sm:p-12 text-center">
          <div className="display text-[32px] sm:text-[44px] leading-[1.02] tracking-tight text-balance">Your saves are already there. Go get them.</div>
          <p className="mt-4 text-[14.5px] text-muted max-w-xl mx-auto">Three days free, no card. The first hundred saves are usually analyzed within twenty minutes of the import landing.</p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link to="/signup" className="btn btn-primary py-2.5 px-5">Start free trial <ArrowRight size={15} /></Link>
            <Link to="/pricing" className="btn py-2.5 px-4">See pricing</Link>
          </div>
        </motion.div>
      </section>

      <PublicFooter />
    </MarketingPage>
  );
}

/* One feature row: text on one side, the real screenshot in a frame with the live vignette overlapping it on the other.
   If the shot 404s the vignette simply stands alone. */
function Vignette({ icon, eyebrow, title, body, points, media, shot, shotAlt, flip }: { icon: ReactNode; eyebrow: string; title: string; body: string; points: string[]; media: ReactNode; shot: string; shotAlt: string; flip?: boolean }) {
  const [hasShot, setHasShot] = useState(true);
  return (
    <motion.div {...riseInView()} className={cn('grid lg:grid-cols-2 gap-8 lg:gap-14 items-center')}>
      <div className={cn('min-w-0', flip && 'lg:order-2')}>
        <div className="eyebrow mb-2.5 flex items-center gap-2 text-accent">{icon}{eyebrow}</div>
        <h3 className="display text-[28px] sm:text-[34px] leading-[1.06] tracking-tight text-ink text-balance">{title}</h3>
        <p className="mt-4 text-[15px] text-ink-2 leading-relaxed">{body}</p>
        <CheckList className="mt-4" items={points} />
      </div>
      <div className={cn('relative min-w-0', flip && 'lg:order-1', hasShot && 'lg:pb-36')}>
        <Frame src={shot} alt={shotAlt} onFail={() => setHasShot(false)} className={cn(hasShot && 'lg:ml-10')} />
        <div className={cn(hasShot ? 'mt-4 lg:mt-0 lg:absolute lg:bottom-0 lg:-left-4 lg:w-[380px] max-w-full' : 'max-w-[440px] mx-auto')}>{media}</div>
      </div>
    </motion.div>
  );
}

function ShotCard({ src, alt, icon, title, body }: { src: string; alt: string; icon: ReactNode; title: string; body: string }) {
  return (
    <motion.div {...riseInView()} className="flex flex-col gap-4">
      <Frame src={src} alt={alt} />
      <div className="flex gap-3">
        <span className="h-7 w-7 grid place-items-center rounded-lg bg-accent-soft text-accent shrink-0">{icon}</span>
        <div><div className="font-medium text-ink">{title}</div><p className="mt-1 text-[13.5px] text-ink-2 leading-relaxed">{body}</p></div>
      </div>
    </motion.div>
  );
}
