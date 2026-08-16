import { Link } from 'react-router';
import { motion } from 'motion/react';
import { ArrowRight, MessageSquareText, Sparkles, Waypoints, Terminal, Cpu, Search, ShieldCheck, Server, Cloud } from 'lucide-react';
import { PublicHeader, PublicFooter, Section, DemoCard, SAMPLES, PricingSection, CostNote, FAQ, CheckList, GITHUB_URL, Github } from '../components/marketing';

const ease = [0.2, 0.7, 0.2, 1] as const;

/* A static replica of the Ask answer UI, citing the three demo cards below. Real component styles, no screenshots. */
function AskDemo() {
  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25, duration: 0.6, ease }} className="relative">
      <div className="absolute -inset-6 rounded-[28px] bg-accent/10 blur-2xl -z-10" />
      <div className="card p-4 sm:p-5 space-y-3">
        <div className="flex justify-end"><div className="max-w-[85%] rounded-2xl rounded-br-md bg-ink text-bg px-3.5 py-2 text-[13px] leading-relaxed">What did I save about writing cold emails?</div></div>
        <div>
          <div className="eyebrow mb-1.5">Sources · 2</div>
          <div className="flex gap-2">
            {SAMPLES.slice(0, 2).map((s, i) => (
              <div key={s.id} className="flex items-center gap-2 rounded-xl border border-line bg-surface p-1.5 pr-3 min-w-0">
                <span className="cite !cursor-default">#{i + 1}</span>
                <span className="text-[12px] truncate max-w-[180px]">{s.title}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card-flat p-3.5 text-[13px] leading-relaxed prose-rs">
          <p className="!my-0">Two saves cover it. The main one says a cold email should be <strong>three lines</strong>: one specific observation about the recipient, one plain sentence about what you do, and a yes/no question — no calendar link in the first message <span className="cite !cursor-default">#1</span>. A design carousel you saved adds a formatting rule that applies to emails too: change weight for emphasis, not typeface <span className="cite !cursor-default">#2</span>.</p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted"><Sparkles size={11} className="text-accent" /> Answers come only from your saves. Click a citation to open the save.</div>
      </div>
    </motion.div>
  );
}

const STEPS = [
  { icon: Terminal, n: '01', title: 'Harvest', body: 'Click a bookmarklet on instagram.com. It pages through your saves at one request per second and sends the list here. Your password never leaves Instagram. Around 3,000 saves take 20 minutes; you can stop and resume.' },
  { icon: Cpu, n: '02', title: 'Analyze', body: 'Each save gets a transcript (reels), four frames read by a vision model, and a structured note: title, one-liner, summary, key points, tags, category, hook. Runs in the background — close the tab, come back later.' },
  { icon: Search, n: '03', title: 'Ask, browse, resurface', body: 'Search by keyword or by meaning. Ask a question in plain words and get an answer that cites the exact saves. See your library as a graph of tags and creators. Each morning three old saves come back up.' },
];

const NUMBERS: Array<[string, string]> = [
  ['6–12 s', 'per save to analyze'],
  ['~$0.008', 'AI cost per reel (we pay it on hosted)'],
  ['12', 'sources cited per answer'],
  ['4', 'export formats: JSON, CSV, Markdown, Obsidian'],
];

export default function Landing() {
  return (
    <div className="relative z-[1] min-h-full">
      <PublicHeader />

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 sm:px-6 pt-14 sm:pt-20 pb-10 grid lg:grid-cols-[1.05fr_1fr] gap-10 lg:gap-14 items-center">
        <div>
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease }} className="eyebrow mb-4">For anyone with a few hundred Instagram saves</motion.div>
          <motion.h1 initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease }} className="display text-[44px] sm:text-[60px] leading-[0.98] tracking-tight">
            Every reel you ever saved, turned into <em className="text-accent not-italic">notes you can search</em>.
          </motion.h1>
          <motion.p initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.6, ease }} className="mt-6 text-[16px] sm:text-[17px] text-ink-2 leading-relaxed max-w-xl">
            Resurfly pulls your saved posts out of Instagram with a bookmarklet, transcribes the reels, and writes a title, a summary, key points and tags for each one. Then you ask questions across all of them and get answers with the exact saves cited.
          </motion.p>
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.5, ease }} className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/signup" className="btn btn-primary py-2.5 px-5 text-[14px]">Start 3-day free trial <ArrowRight size={15} /></Link>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="btn py-2.5 px-4 text-[14px]"><Github size={15} /> Self-host it (MIT)</a>
          </motion.div>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.35 }} className="mt-4 text-[12.5px] text-muted">No card needed · 100 saves analyzed in the trial · Export everything, any time</motion.div>
        </div>
        <AskDemo />
      </section>

      {/* Numbers strip */}
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {NUMBERS.map(([n, l], i) => (
            <motion.div key={l} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 + i * 0.05 }} className="card-flat p-4">
              <div className="display text-[26px] leading-none tabular">{n}</div>
              <div className="text-[12px] text-muted mt-1.5 leading-snug">{l}</div>
            </motion.div>
          ))}
        </div>
      </div>

      {/* How it works */}
      <Section id="how" eyebrow="How it works" title="Three steps. The first one is the only one you do by hand." lead="Instagram has no API for saved posts, so the export happens in your browser. Everything after that runs on the server.">
        <ol className="grid md:grid-cols-3 gap-4">
          {STEPS.map((s, i) => (
            <motion.li key={s.n} initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-60px' }} transition={{ delay: i * 0.08, duration: 0.45, ease }} className="card p-6">
              <div className="flex items-center justify-between mb-4"><span className="h-9 w-9 grid place-items-center rounded-xl bg-accent-soft text-accent"><s.icon size={17} /></span><span className="font-mono text-[11px] text-muted">{s.n}</span></div>
              <div className="display text-[24px] mb-2">{s.title}</div>
              <p className="text-[13.5px] text-ink-2 leading-relaxed">{s.body}</p>
            </motion.li>
          ))}
        </ol>
        <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-[12.5px] text-muted">
          <span className="inline-flex items-center gap-1.5"><MessageSquareText size={13} /> Ask with citations</span>
          <span className="inline-flex items-center gap-1.5"><Waypoints size={13} /> Graph of tags, creators, categories</span>
          <span className="inline-flex items-center gap-1.5"><Sparkles size={13} /> Three saves resurfaced daily</span>
          <span className="inline-flex items-center gap-1.5"><ShieldCheck size={13} /> Comment → DM automations on Meta's official API</span>
        </div>
      </Section>

      {/* Demo */}
      <Section eyebrow="What a save turns into" title="Three saves, after analysis." lead="Sample output. The title, one-liner and key points are written by the model from the transcript, the frames and the caption. Tags and category come from a fixed vocabulary so filters stay clean.">
        <div className="grid md:grid-cols-3 gap-4">
          {SAMPLES.map((s, i) => <DemoCard key={s.id} s={s} i={i} onCite={i < 2 ? i + 1 : undefined} />)}
        </div>
        <div className="mt-4 text-[12px] text-muted">Each note also has a full summary, the transcript, on-screen text, quotes, entities (people, tools, places, brands), a "why you probably saved this" guess, and a remix idea. Everything is a field in your export.</div>
      </Section>

      {/* Open source AND hosted */}
      <Section id="open-source" eyebrow="Open source and hosted" title="Same code. Two ways to run it." lead="This is the model n8n and Plausible use: the code is open, the convenience is paid. Pick whichever fits.">
        <div className="grid md:grid-cols-2 gap-4">
          <div className="card p-6 sm:p-7 flex flex-col">
            <div className="flex items-center gap-2 mb-3"><span className="h-8 w-8 grid place-items-center rounded-lg bg-surface-2 text-ink"><Server size={15} /></span><span className="display text-[24px]">Self-host — free</span></div>
            <p className="text-[13.5px] text-ink-2 leading-relaxed">The whole app is on GitHub under the MIT license. One Docker container, one OpenAI key, one volume for the SQLite file and the media.</p>
            <CheckList className="mt-4" items={[<>About <b>$5 a month</b> for a small server (Railway, Fly, a VPS)</>, <>Roughly <b>$7.50 of OpenAI per 1,000 saves</b> on the standard tier, $3 on economy</>, 'You own the database file and every thumbnail on your own disk', 'Point it at any OpenAI-compatible endpoint if you prefer']} />
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="btn mt-6 self-start"><Github size={14} /> Read the README</a>
          </div>
          <div className="card p-6 sm:p-7 flex flex-col border-accent/60">
            <div className="flex items-center gap-2 mb-3"><span className="h-8 w-8 grid place-items-center rounded-lg bg-accent-soft text-accent"><Cloud size={15} /></span><span className="display text-[24px]">Hosted — resurfly.com</span></div>
            <p className="text-[13.5px] text-ink-2 leading-relaxed">Or let us run it. We pay for the servers and the OpenAI calls, keep the harvester working when Instagram changes its pages, and answer support.</p>
            <CheckList className="mt-4" items={['Results start within minutes of your first harvest — nothing to install', 'OpenAI keys, servers and upkeep included in the price', 'Cancel any time; access runs to the end of the period', 'Export always works — JSON, CSV, Markdown, Obsidian']} />
            <Link to="/signup" className="btn btn-primary mt-6 self-start">Start free trial <ArrowRight size={14} /></Link>
          </div>
        </div>
      </Section>

      <PricingSection />
      <CostNote />

      <Section eyebrow="FAQ" title="Short answers.">
        <FAQ />
      </Section>

      {/* Closing CTA */}
      <section className="mx-auto max-w-6xl px-4 sm:px-6 pb-4">
        <div className="card p-8 sm:p-10 text-center">
          <div className="display text-[30px] sm:text-[38px] leading-[1.05]">Your saves are already there. Go get them.</div>
          <p className="mt-3 text-[14px] text-muted max-w-xl mx-auto">Three days free, no card. The first hundred saves are usually analyzed within twenty minutes of your harvest landing.</p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link to="/signup" className="btn btn-primary py-2.5 px-5">Start free trial <ArrowRight size={15} /></Link>
            <Link to="/pricing" className="btn py-2.5 px-4">See pricing</Link>
          </div>
        </div>
      </section>

      <PublicFooter />
    </div>
  );
}
