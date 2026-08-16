import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { motion } from 'motion/react';
import { ArrowRight, Check, AlertTriangle } from 'lucide-react';
import { useAuth } from '../lib/store';
import { Logo } from '../components/ui';
import { PublicHeader, GITHUB_URL, PRIVACY_URL } from '../components/marketing';
import { usePlansCatalog } from '../components/Pricing';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Signup() {
  const auth = useAuth();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const { catalog } = usePlansCatalog();
  const intendedPlan = sp.get('plan');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = EMAIL_RE.test(email.trim()) && password.length >= 8;
  const trial = catalog.plans.find((p) => p.id === 'trial');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true); setErr(null);
    try {
      await auth.signup(email.trim(), password, name.trim() || undefined);
      // The Gate re-renders into the app once /api/auth/me says authenticated; if they came from a pricing card, land them on Billing with the modal.
      nav(intendedPlan && intendedPlan !== 'trial' ? `/billing?upgrade=${encodeURIComponent(intendedPlan)}${sp.get('interval') ? `&interval=${sp.get('interval')}` : ''}` : '/', { replace: true });
    } catch (e: any) { setErr(e?.message || 'Sign up failed'); } finally { setBusy(false); }
  };

  return (
    <div className="relative z-[1] min-h-full flex flex-col">
      <PublicHeader active="signup" />
      <div className="flex-1 grid lg:grid-cols-[1fr_1fr] max-w-6xl mx-auto w-full px-4 sm:px-6 py-10 lg:py-16 gap-10 items-center">
        {/* Left: what you get */}
        <div className="hidden lg:block max-w-lg">
          <motion.h1 initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.2, 0.7, 0.2, 1] }} className="display text-[48px] leading-[1] tracking-tight">
            Three days. Your newest <em className="text-accent not-italic">100 saves</em>, analyzed.
          </motion.h1>
          <motion.p initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.6 }} className="mt-5 text-[15px] text-ink-2 leading-relaxed">
            Enough to see what the notes look like on your own library and to ask real questions. If it's not for you, export or delete and walk away — no card was ever entered.
          </motion.p>
          <motion.ul initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.25 }} className="mt-6 space-y-2 text-[13.5px] text-ink-2">
            {[`${trial?.limits.analyzeTotal ?? 100} saves analyzed — transcript, summary, key points, tags`, `${trial?.limits.askPerMonth ?? 20} questions with cited answers`, 'Graph, daily resurface, one DM automation rule', 'Full export in JSON, CSV, Markdown or Obsidian at any time', 'After the trial: browse-only until you upgrade; nothing is deleted for 30 days'].map((t) => (
              <li key={t} className="flex items-start gap-2"><Check size={14} className="text-accent shrink-0 mt-[3px]" />{t}</li>
            ))}
          </motion.ul>
          <div className="mt-8 text-[12px] text-muted font-mono">open source · MIT · <a className="underline" href={GITHUB_URL} target="_blank" rel="noreferrer">github.com/tairqaldy/resurfly</a></div>
        </div>

        {/* Right: form */}
        <div className="flex items-center justify-center">
          <motion.form onSubmit={submit} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.5 }} className="w-full max-w-sm card p-7">
            <div className="lg:hidden flex items-center gap-2.5 mb-6"><Logo size={24} /><span className="display text-[22px]">Resurfly</span></div>
            <div className="eyebrow mb-1">Start your free trial</div>
            <h2 className="display text-[28px] mb-1">Create your account</h2>
            <div className="mb-5 text-[12.5px] text-muted">{catalog.trialDays} days free · no card needed{intendedPlan && intendedPlan !== 'trial' ? ` · you can upgrade to ${intendedPlan[0].toUpperCase()}${intendedPlan.slice(1)} right after` : ''}</div>
            {!auth.signupsEnabled && (
              <div className="mb-4 flex items-start gap-2 rounded-xl border border-warn/40 bg-warn-soft p-3 text-[12.5px] text-ink-2"><AlertTriangle size={16} className="text-warn shrink-0 mt-0.5" /><div>Signups are closed right now. You can still <a className="underline" href={GITHUB_URL} target="_blank" rel="noreferrer">self-host</a> or email hello@resurfly.com for an invite.</div></div>
            )}
            <label className="block mb-3">
              <div className="text-[12.5px] font-medium text-ink-2 mb-1.5">Email</div>
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" autoFocus className="input" placeholder="you@example.com" />
            </label>
            <label className="block mb-3">
              <div className="text-[12.5px] font-medium text-ink-2 mb-1.5">Password <span className="text-muted font-normal">· at least 8 characters</span></div>
              <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="new-password" className="input" placeholder="••••••••" minLength={8} />
            </label>
            <label className="block mb-5">
              <div className="text-[12.5px] font-medium text-ink-2 mb-1.5">Name <span className="text-muted font-normal">· optional</span></div>
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className="input" placeholder="How should we greet you?" />
            </label>
            {err && <div className="mb-4 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{err}</div>}
            <button disabled={busy || !valid || !auth.signupsEnabled} className="btn btn-primary w-full py-2.5">{busy ? 'Creating your account…' : 'Start free trial'} <ArrowRight size={15} /></button>
            <div className="mt-4 text-[11.5px] text-muted leading-relaxed">By continuing you agree to the <a className="underline" href={PRIVACY_URL} target="_blank" rel="noreferrer">privacy policy</a>. We store your email, a password hash and your saves; nothing is shared or sold.</div>
            <div className="mt-4 text-[12.5px] text-muted text-center">Already have an account? <Link to="/login" className="text-accent underline underline-offset-2">Log in</Link></div>
          </motion.form>
        </div>
      </div>
    </div>
  );
}
