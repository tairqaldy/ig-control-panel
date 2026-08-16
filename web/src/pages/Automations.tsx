import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { Bot, Plus, Trash2, Pencil, Play, CheckCircle2, XCircle, MessageCircle, MessageSquare, Copy, RefreshCw, ExternalLink, FlaskConical, ArrowRight, Zap } from 'lucide-react';
import { api } from '../lib/api';
import type { Rule } from '../lib/types';
import { PageHeader, Modal, Field, Toggle, Tabs, Empty } from '../components/ui';
import { cn, copyText, fmtAgo } from '../lib/utils';

const TRIGGERS: Array<{ id: Rule['trigger_type']; label: string; desc: string }> = [
  { id: 'dm_keyword', label: 'DM contains keyword', desc: 'Someone sends you a DM containing one of the keywords → auto-reply.' },
  { id: 'comment_keyword', label: 'Comment contains keyword → DM', desc: 'Someone comments a keyword on your post → send them a private DM (and optionally reply publicly).' },
  { id: 'story_reply', label: 'Story reply contains keyword', desc: 'Someone replies to your story with a keyword → auto-reply.' },
  { id: 'dm_any', label: 'Any DM (catch-all)', desc: 'Reply to any DM that didn’t match another rule. Put this last (highest priority number).' },
  { id: 'comment_any', label: 'Any comment (catch-all)', desc: 'DM anyone who comments on your posts. Use with a long cooldown.' },
];

const EMPTY: Partial<Rule> & { keywordsText?: string } = { name: '', enabled: 1, trigger_type: 'comment_keyword', match_mode: 'contains', keywordsText: '', reply_text: '', reply_link: '', public_reply_text: '', cooldown_minutes: 1440, priority: 100 };

function RuleEditor({ rule, onClose }: { rule: (Partial<Rule> & { keywordsText?: string }) | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<any>(() => rule ? { ...rule, keywordsText: rule.keywordsText ?? (rule.keywords ? JSON.parse(rule.keywords).join(', ') : '') } : { ...EMPTY });
  const save = useMutation({
    mutationFn: () => { const body = { ...f, keywords: f.keywordsText.split(',').map((s: string) => s.trim()).filter(Boolean), enabled: !!f.enabled }; return f.id ? api.put(`/api/automations/rules/${f.id}`, body) : api.post('/api/automations/rules', body); },
    onSuccess: () => { toast.success('Rule saved'); qc.invalidateQueries({ queryKey: ['rules'] }); qc.invalidateQueries({ queryKey: ['auto-status'] }); onClose(); },
    onError: (e: any) => toast.error(e.message),
  });
  const set = (k: string, v: any) => setF((s: any) => ({ ...s, [k]: v }));
  const isComment = f.trigger_type?.startsWith('comment');
  const isAny = f.trigger_type?.endsWith('_any');
  return (
    <Modal open onClose={onClose} width="max-w-2xl">
      <div className="p-6">
        <div className="eyebrow mb-1">{f.id ? 'Edit rule' : 'New rule'}</div>
        <h3 className="display text-[26px] mb-5">{f.name || 'Untitled rule'}</h3>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Name"><input value={f.name} onChange={(e) => set('name', e.target.value)} className="input" placeholder="e.g. Send checklist link" /></Field>
          <Field label="Trigger">
            <select value={f.trigger_type} onChange={(e) => set('trigger_type', e.target.value)} className="input">{TRIGGERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
          </Field>
        </div>
        <div className="mt-1 text-[12px] text-muted">{TRIGGERS.find((t) => t.id === f.trigger_type)?.desc}</div>
        {!isAny && (
          <div className="grid sm:grid-cols-[1fr_180px] gap-4 mt-4">
            <Field label="Keywords" hint="Comma-separated. Case-insensitive."><input value={f.keywordsText} onChange={(e) => set('keywordsText', e.target.value)} className="input" placeholder="guide, link, template" /></Field>
            <Field label="Match"><select value={f.match_mode} onChange={(e) => set('match_mode', e.target.value)} className="input"><option value="contains">contains</option><option value="exact">exact</option><option value="starts_with">starts with</option><option value="regex">regex</option></select></Field>
          </div>
        )}
        <div className="mt-4">
          <Field label={isComment ? 'Private DM reply' : 'Reply text'} hint={<>Use <code className="font-mono">{'{{username}}'}</code> for their handle. Sent as a DM{isComment ? ' (private reply to the comment — allowed once per comment, within 7 days)' : ''}.</>}>
            <textarea value={f.reply_text} onChange={(e) => set('reply_text', e.target.value)} rows={3} className="input" placeholder="Hey {{username}}! Here’s the link you asked for 👇" />
          </Field>
        </div>
        <div className="grid sm:grid-cols-2 gap-4 mt-4">
          <Field label="Link to append (optional)"><input value={f.reply_link || ''} onChange={(e) => set('reply_link', e.target.value)} className="input" placeholder="https://…" /></Field>
          {isComment && <Field label="Public comment reply (optional)"><input value={f.public_reply_text || ''} onChange={(e) => set('public_reply_text', e.target.value)} className="input" placeholder="Sent you a DM ✉️" /></Field>}
        </div>
        <div className="grid sm:grid-cols-3 gap-4 mt-4">
          <Field label="Cooldown (minutes)" hint="Per person, per rule. 0 = every time."><input type="number" value={f.cooldown_minutes} onChange={(e) => set('cooldown_minutes', Number(e.target.value))} className="input" /></Field>
          <Field label="Priority" hint="Lower runs first."><input type="number" value={f.priority} onChange={(e) => set('priority', Number(e.target.value))} className="input" /></Field>
          <div className="pt-7"><Toggle checked={!!f.enabled} onChange={(v) => set('enabled', v ? 1 : 0)} label="Enabled" /></div>
        </div>
        <div className="mt-6 flex justify-end gap-2"><button onClick={onClose} className="btn">Cancel</button><button onClick={() => save.mutate()} disabled={save.isPending || !f.name} className="btn btn-primary">Save rule</button></div>
      </div>
    </Modal>
  );
}

export default function Automations() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['auto-status'], queryFn: () => api.get<any>('/api/automations/status') });
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api.get<{ rules: Rule[] }>('/api/automations/rules') });
  const events = useQuery({ queryKey: ['auto-events'], queryFn: () => api.get<{ events: any[] }>('/api/automations/events?limit=100'), refetchInterval: 10000 });
  const [editing, setEditing] = useState<any | null>(null);
  const [tab, setTab] = useState<'rules' | 'log' | 'test'>('rules');
  const [testKind, setTestKind] = useState<'dm' | 'comment' | 'story_reply'>('comment');
  const [testText, setTestText] = useState('');
  const [testResult, setTestResult] = useState<any>(null);
  const del = useMutation({ mutationFn: (id: number) => api.del(`/api/automations/rules/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['rules'] }); toast.success('Deleted'); } });
  const toggle = useMutation({ mutationFn: (r: Rule) => api.put(`/api/automations/rules/${r.id}`, { enabled: !r.enabled }), onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }) });
  const test = useMutation({ mutationFn: () => api.post<any>('/api/automations/test', { kind: testKind, text: testText }), onSuccess: setTestResult });
  const whoami = useMutation({ mutationFn: () => api.post<any>('/api/automations/whoami'), onSuccess: (r) => (r.ok ? toast.success(`Connected as @${r.me?.username || r.me?.user_id}`) : toast.error(r.message)) });
  const s = status.data;

  return (
    <div>
      <PageHeader eyebrow="Automations · ManyChat-lite" title={<>Instagram DM <em className="text-accent not-italic">autopilot</em></>} subtitle="Keyword auto-replies, comment-to-DM funnels and story-reply responders on Meta’s official Instagram Messaging API. Runs inside this app — no third-party bot platform, no monthly fee." actions={<button onClick={() => setEditing({ ...EMPTY })} className="btn btn-primary"><Plus size={14} /> New rule</button>} />

      {/* Connection: a checklist that tells you exactly where you are */}
      {(() => {
        const steps = [
          { ok: !!s?.verifyTokenSet, label: 'Verify token set', hint: 'Settings → Instagram automations (any string you choose)' },
          { ok: !!s?.accessTokenSet, label: 'Access token pasted', hint: 'Meta app → Instagram → API setup → Generate token' },
          { ok: !!s?.igUserId, label: 'Instagram user id set', hint: 'from GET /me?fields=user_id — "Test connection" fills it in' },
          { ok: !!s?.appSecretSet, label: 'App secret set (signed webhooks)', hint: 'Meta app → Settings → Basic → App Secret' },
          { ok: !!s?.configured && (s?.events24h ?? 0) > 0, label: 'Webhook receiving events', hint: 'Meta app → Configure webhooks → Verify and save, subscribe messages + comments; app in Live mode' },
        ];
        const done = steps.filter((x) => x.ok).length;
        return (
          <div className={cn('card p-5 mb-6', s && !s.configured && 'border-warn/40')}>
            <div className="flex flex-wrap items-start gap-4">
              <div className="min-w-[260px] flex-1">
                <div className="flex items-center gap-2 mb-1">
                  {s?.configured ? <CheckCircle2 size={16} className="text-accent" /> : <XCircle size={16} className="text-warn" />}
                  <span className="text-[14px] font-medium">{s?.configured ? 'Connected to the Instagram API' : `Setup ${done}/${steps.length}`}</span>
                  {s?.igUserId && <span className="font-mono text-[11px] text-muted">IG user id {s.igUserId}</span>}
                </div>
                <div className="text-[12.5px] text-muted leading-relaxed mb-3">
                  {s?.configured ? 'Your rules run on incoming DMs, story replies and comments. Keep the Meta app in Live mode so events from real people arrive.' : <>~15 minutes, once. The full walkthrough with screenshots-in-words is in <a className="text-accent underline" href="https://github.com/tairqaldy/resurfly/blob/main/docs/AUTOMATIONS.md" target="_blank" rel="noreferrer">docs/AUTOMATIONS.md</a>.</>}
                </div>
                <ol className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
                  {steps.map((st, i) => (
                    <li key={i} className="flex items-start gap-2 text-[12.5px]">
                      <span className={cn('mt-0.5 h-4 w-4 shrink-0 rounded-full grid place-items-center border', st.ok ? 'bg-accent border-accent text-accent-ink' : 'border-line-2 text-muted')}>{st.ok ? <CheckCircle2 size={11} /> : <span className="font-mono text-[9px]">{i + 1}</span>}</span>
                      <span><span className={cn(st.ok ? 'text-ink' : 'text-ink-2')}>{st.label}</span><span className="block text-[11px] text-muted">{st.hint}</span></span>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="flex flex-col gap-2 min-w-[220px]">
                <div className="card-flat p-3 text-[12px]">
                  <div className="eyebrow mb-1">Webhook URL</div>
                  <div className="flex items-center gap-1"><code className="font-mono text-[11px] truncate flex-1">{s?.webhookUrl}</code><button onClick={() => { copyText(s?.webhookUrl || ''); toast.success('Webhook URL copied'); }} className="btn btn-ghost btn-sm !px-1"><Copy size={12} /></button></div>
                </div>
                <button onClick={() => whoami.mutate()} disabled={!s?.accessTokenSet} className="btn btn-sm"><RefreshCw size={13} className={cn(whoami.isPending && 'animate-spin')} /> Test connection</button>
                <a href="/settings#automations" className="btn btn-sm">Enter credentials <ArrowRight size={13} /></a>
                <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm text-muted"><ExternalLink size={12} /> Meta for Developers</a>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="mb-4"><Tabs value={tab} onChange={setTab} tabs={[{ id: 'rules', label: `Rules (${rules.data?.rules.length ?? 0})` }, { id: 'test', label: <span className="inline-flex items-center gap-1.5"><FlaskConical size={13} /> Test</span> }, { id: 'log', label: `Activity (${s?.events24h ?? 0} today)` }]} /></div>

      {tab === 'rules' && (
        <div className="mb-4 flex flex-wrap gap-2">
          {[
            { name: 'Comment LINK → send link', trigger_type: 'comment_keyword', keywordsText: 'link, send, want', reply_text: 'Hey {{username}}! Here’s the link you asked for 👇', public_reply_text: 'Sent you a DM ✉️', desc: 'The classic lead magnet funnel' },
            { name: 'DM keyword → resource', trigger_type: 'dm_keyword', keywordsText: 'guide, template, checklist', reply_text: 'Here you go — the resource you asked for 👇', desc: 'Auto-reply to keyword DMs' },
            { name: 'Story reply → thanks + link', trigger_type: 'story_reply', keywordsText: 'yes, me, info', reply_text: 'Thanks for replying to my story! Here’s the thing I mentioned 👇', desc: 'Story engagement responder' },
          ].map((t) => (
            <button key={t.name} onClick={() => setEditing({ ...EMPTY, ...t })} className="card px-3 py-2 text-left hover:border-line-2 transition-colors"><div className="text-[12.5px] font-medium inline-flex items-center gap-1.5"><Zap size={12} className="text-accent" />{t.name}</div><div className="text-[11px] text-muted">{t.desc}</div></button>
          ))}
        </div>
      )}
      {tab === 'rules' && (
        rules.data && rules.data.rules.length ? (
          <div className="space-y-2">
            {rules.data.rules.map((r, i) => {
              const kws = JSON.parse(r.keywords || '[]') as string[];
              const T = TRIGGERS.find((t) => t.id === r.trigger_type);
              return (
                <motion.div key={r.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }} className={cn('card p-4 flex items-start gap-4', !r.enabled && 'opacity-60')}>
                  <div className={cn('mt-0.5 h-8 w-8 shrink-0 grid place-items-center rounded-lg', r.trigger_type.startsWith('comment') ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent')}>{r.trigger_type.startsWith('comment') ? <MessageCircle size={16} /> : <MessageSquare size={16} />}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap"><span className="text-[14px] font-medium">{r.name}</span><span className="text-[11.5px] text-muted">{T?.label}</span>{!r.enabled && <span className="chip">off</span>}</div>
                    <div className="mt-1 flex flex-wrap gap-1">{kws.length ? kws.map((k) => <span key={k} className="chip font-mono text-[11px]">{k}</span>) : <span className="text-[12px] text-muted">any message</span>}<span className="text-[11px] text-muted self-center ml-1">({r.match_mode.replace('_', ' ')})</span></div>
                    <div className="mt-2 text-[12.5px] text-ink-2 clamp-2 whitespace-pre-wrap">↳ {r.reply_text}{r.reply_link ? ` ${r.reply_link}` : ''}</div>
                    <div className="mt-1.5 text-[11px] text-muted font-mono">{r.hit_count} hits{r.last_hit_at ? ` · last ${fmtAgo(r.last_hit_at)}` : ''} · cooldown {r.cooldown_minutes}m · priority {r.priority}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Toggle checked={!!r.enabled} onChange={() => toggle.mutate(r)} />
                    <button onClick={() => setEditing(r)} className="btn btn-ghost btn-sm !px-1.5"><Pencil size={14} /></button>
                    <button onClick={() => { if (confirm('Delete rule?')) del.mutate(r.id); }} className="btn btn-ghost btn-sm !px-1.5 text-danger"><Trash2 size={14} /></button>
                  </div>
                </motion.div>
              );
            })}
          </div>
        ) : (
          <Empty icon={<Bot size={28} />} title="No rules yet" body="Start with the classic: “comment LINK on my post → I DM you the link”. Rules run top-down by priority; the first match wins." action={<div className="flex gap-2 justify-center"><button onClick={() => setEditing({ ...EMPTY, name: 'Comment LINK → send link', trigger_type: 'comment_keyword', keywordsText: 'link', reply_text: 'Hey {{username}}! Here’s the link you asked for 👇', public_reply_text: 'Sent you a DM ✉️' })} className="btn btn-primary"><Zap size={14} /> Use template</button><button onClick={() => setEditing({ ...EMPTY })} className="btn">Blank rule</button></div>} />
        )
      )}

      {tab === 'test' && (
        <div className="card p-6 max-w-2xl">
          <div className="eyebrow mb-2">Dry run</div>
          <p className="text-[13px] text-muted mb-4">Simulate an incoming message and see which rule would fire. Nothing is sent.</p>
          <div className="flex flex-wrap gap-2 items-end">
            <Field label="Kind"><select value={testKind} onChange={(e) => setTestKind(e.target.value as any)} className="input w-40"><option value="comment">Comment</option><option value="dm">DM</option><option value="story_reply">Story reply</option></select></Field>
            <div className="flex-1 min-w-[220px]"><Field label="Text"><input value={testText} onChange={(e) => setTestText(e.target.value)} className="input" placeholder="link please!" /></Field></div>
            <button onClick={() => test.mutate()} className="btn btn-primary"><Play size={14} /> Run</button>
          </div>
          <AnimatePresence>
            {testResult && (
              <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-5">
                {testResult.matched ? <div className="rounded-xl border border-accent/40 bg-accent-soft/60 p-3 text-[13px]"><CheckCircle2 size={14} className="inline text-accent mr-1.5 -mt-0.5" />Would fire: <b>{testResult.matched.name}</b> → “{testResult.matched.reply_text}”</div> : <div className="rounded-xl border border-line bg-surface-2 p-3 text-[13px]">No rule matches.</div>}
                <div className="mt-3 text-[12px] text-muted">Candidates: {testResult.candidates.map((c: any) => `${c.name} (${c.matches ? 'match' : 'no'}${c.enabled ? '' : ', disabled'})`).join(' · ') || 'none'}</div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {tab === 'log' && (
        events.data?.events.length ? (
          <div className="card-flat divide-y divide-line">
            {events.data.events.map((e) => (
              <div key={e.id} className="flex items-start gap-3 px-4 py-2.5 text-[13px]">
                <span className={cn('mt-1.5 h-2 w-2 rounded-full shrink-0', e.status === 'error' ? 'bg-danger' : e.direction === 'in' ? 'bg-warn' : e.direction === 'out' ? 'bg-accent' : 'bg-line-2')} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap"><span className="font-mono text-[11px] text-muted uppercase">{e.type}</span>{e.sender_username && <span className="text-[12px]">@{e.sender_username}</span>}{e.sender_id && !e.sender_username && <span className="font-mono text-[11px] text-muted">{e.sender_id}</span>}{e.rule_id && <span className="chip">rule #{e.rule_id}</span>}</div>
                  <div className="text-ink-2 truncate">{e.text}</div>
                  {e.error && <div className="text-danger text-[12px]">{e.error}</div>}
                </div>
                <span className="text-[11px] text-muted shrink-0">{fmtAgo(e.ts)}</span>
              </div>
            ))}
          </div>
        ) : <Empty title="No activity yet" body="Incoming DMs/comments and outgoing replies will show up here once the webhook is connected." />
      )}

      {editing && <RuleEditor rule={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
