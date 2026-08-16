import { useState } from 'react';
import { Link } from 'react-router';
import { motion } from 'motion/react';
import { ArrowRight, AlertTriangle } from 'lucide-react';
import { useAuth } from '../lib/store';
import { Logo } from '../components/ui';

export default function Login() {
  const auth = useAuth();
  const hosted = auth.hosted;
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await auth.login(u.trim(), p); } catch (e: any) { setErr(e?.message || 'Login failed'); } finally { setBusy(false); }
  };

  return (
    <div className="relative z-[1] min-h-full grid lg:grid-cols-[1.1fr_1fr]">
      {/* Left: manifesto */}
      <div className="hidden lg:flex flex-col justify-between p-12 border-r border-line/70">
        {hosted ? <Link to="/" className="flex items-center gap-3"><Logo size={28} /><span className="display text-[24px]">Resurfly</span></Link> : <div className="flex items-center gap-3"><Logo size={28} /><span className="display text-[24px]">Resurfly</span></div>}
        <div className="max-w-xl">
          <motion.h1 initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.2, 0.7, 0.2, 1] }} className="display text-[64px] leading-[0.98] tracking-tight">
            Your saved posts are a <em className="text-accent not-italic">graveyard</em>.<br />Dig them up.
          </motion.h1>
          <motion.p initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12, duration: 0.6, ease: [0.2, 0.7, 0.2, 1] }} className="mt-6 text-[16px] text-ink-2 leading-relaxed max-w-md">
            Every reel, post and carousel you ever saved — transcribed, summarized, tagged, searchable, and talkable. Structured data instead of a bottomless bookmarks tab.
          </motion.p>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }} className="mt-10 grid grid-cols-3 gap-6 max-w-md">
            {[['Analyze', 'Transcript + frames + caption → clean structured notes'], ['Ask', 'Chat with everything you saved, with citations'], ['Graph', 'See the shape of your own taste']].map(([t, d]) => (
              <div key={t}><div className="eyebrow mb-1">{t}</div><div className="text-[12.5px] text-muted leading-snug">{d}</div></div>
            ))}
          </motion.div>
        </div>
        <div className="text-[12px] text-muted font-mono">{hosted ? <>open source · hosted · <Link to="/pricing" className="underline hover:text-ink">3-day free trial</Link></> : 'open source · self-hosted · single user'}</div>
      </div>
      {/* Right: form */}
      <div className="flex items-center justify-center p-6">
        <motion.form onSubmit={submit} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.5 }} className="w-full max-w-sm card p-7">
          <div className="lg:hidden flex items-center gap-2.5 mb-6">{hosted ? <Link to="/" className="flex items-center gap-2.5"><Logo size={24} /><span className="display text-[22px]">Resurfly</span></Link> : <><Logo size={24} /><span className="display text-[22px]">Resurfly</span></>}</div>
          <div className="eyebrow mb-1">Welcome back</div>
          <h2 className="display text-[28px] mb-6">{hosted ? 'Log in' : 'Unlock your library'}</h2>
          {!hosted && !auth.loginEnabled && (
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-warn/40 bg-warn-soft p-3 text-[12.5px] text-ink-2"><AlertTriangle size={16} className="text-warn shrink-0 mt-0.5" /><div>Login isn’t configured yet. Set <code className="font-mono">APP_USERNAME</code> and <code className="font-mono">APP_PASSCODE</code> environment variables on the server, then restart.</div></div>
          )}
          <label className="block mb-3">
            <div className="text-[12.5px] font-medium text-ink-2 mb-1.5">{hosted ? 'Email' : 'Username'}</div>
            <input value={u} onChange={(e) => setU(e.target.value)} type={hosted ? 'email' : 'text'} autoComplete={hosted ? 'email' : 'username'} autoFocus className="input" placeholder={hosted ? 'you@example.com' : 'you'} />
          </label>
          <label className="block mb-5">
            <div className="text-[12.5px] font-medium text-ink-2 mb-1.5">{hosted ? 'Password' : 'Passcode'}</div>
            <input value={p} onChange={(e) => setP(e.target.value)} type="password" autoComplete="current-password" className="input" placeholder="••••••••" />
          </label>
          {err && <div className="mb-4 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{err}</div>}
          <button disabled={busy || !u || !p} className="btn btn-primary w-full py-2.5">{busy ? (hosted ? 'Logging in…' : 'Unlocking…') : hosted ? 'Log in' : 'Enter'} <ArrowRight size={15} /></button>
          {hosted ? (
            <div className="mt-5 text-[12.5px] text-muted text-center">New here? <Link to="/signup" className="text-accent underline underline-offset-2">Start your free trial</Link><span className="text-muted-2"> · 3 days, no card</span></div>
          ) : (
            <div className="mt-5 text-[11.5px] text-muted leading-relaxed">Single-user dashboard. Credentials are set by whoever deployed this instance (see README).</div>
          )}
        </motion.form>
      </div>
    </div>
  );
}
