import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { ArrowRight, Bot, CheckCircle2, ChevronDown, Clapperboard, Copy, ExternalLink, Images, MessageCircle, MessageSquare, Pencil, Plus, RefreshCw, Timer, Trash2, TriangleAlert, UserCheck, XCircle, Zap } from 'lucide-react';
import { api } from '../lib/api';
import {
  type AutomationRule, type RuleDraft, type TriggerFamily,
  EMPTY_DRAFT, draftFromRule, familyOf, fmtCooldown, parseKeywords, parseMediaIds, triggerSentence,
} from '../lib/types-automations';
import { useQuota } from '../lib/store';
import { meterFull } from '../lib/plans';
import { PageHeader, Tabs, Empty, Toggle } from '../components/ui';
import { UsageBar } from '../components/Pricing';
import { ConnectCard, useIgAccount, startInstagramConnect } from '../components/instagram';
import { QuickStart } from '../components/instagram/QuickStart';
import { HealthCard } from '../components/instagram/HealthCard';
import { RuleBuilder } from '../components/instagram/RuleBuilder';
import { ActivityLog } from '../components/instagram/ActivityLog';
import { DIAGNOSTICS_KEY, RULES_KEY, useAutomationEvents, useRules } from '../components/instagram/useAutomations';
import { cn, copyText, fmtAgo } from '../lib/utils';

const FAMILY_ICON: Record<TriggerFamily, typeof MessageCircle> = { comment: MessageCircle, dm: MessageSquare, dm_first: UserCheck, story_reply: Clapperboard };

/** OSS / own-Meta-app path: the old step checklist, behind a disclosure under the Connect card. Only shown when there is no OAuth connection. */
function OwnAppSetup({ s }: { s: any }) {
  const [open, setOpen] = useState(false);
  const whoami = useMutation({ mutationFn: () => api.post<any>('/api/automations/whoami'), onSuccess: (r) => (r.ok ? toast.success(`Connected as @${r.me?.username || r.me?.user_id}`) : toast.error(r.message)) });
  const steps = [
    { ok: !!s?.verifyTokenSet, label: 'Verify token set', hint: 'Settings → Integrations → Bring your own Meta app (any string you choose)' },
    { ok: !!s?.accessTokenSet, label: 'Access token pasted', hint: 'Meta app → Instagram → API setup → Generate token' },
    { ok: !!s?.igUserId, label: 'Instagram user id set', hint: 'from GET /me?fields=user_id — "Test connection" fills it in' },
    { ok: !!s?.appSecretSet, label: 'App secret set (signed webhooks)', hint: 'Meta app → Settings → Basic → App Secret' },
    { ok: !!s?.configured && (s?.events24h ?? 0) > 0, label: 'Webhook receiving events', hint: 'Meta app → Configure webhooks → Verify and save, subscribe messages + comments; app in Live mode' },
  ];
  const done = steps.filter((x) => x.ok).length;
  return (
    <div className="mt-2">
      <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 text-[12.5px] text-muted hover:text-ink px-1 py-1" aria-expanded={open}>
        <ChevronDown size={13} className={cn('transition-transform', open && 'rotate-180')} /> Own Meta app setup · {done}/{steps.length} done
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="own" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className={cn('card-flat p-4 mt-1', s && !s.configured && 'border-warn/40')}>
              <div className="flex flex-wrap items-start gap-4">
                <div className="min-w-[260px] flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    {s?.configured ? <CheckCircle2 size={16} className="text-accent" /> : <XCircle size={16} className="text-warn" />}
                    <span className="text-[13.5px] font-medium">{s?.configured ? 'Credentials in place' : `Setup ${done}/${steps.length}`}</span>
                    {s?.igUserId && <span className="font-mono text-[11px] text-muted">IG user id {s.igUserId}</span>}
                  </div>
                  <div className="text-[12.5px] text-muted leading-relaxed mb-3">About 15 minutes, once. The full walkthrough is in <a className="text-accent underline" href="https://github.com/tairqaldy/resurfly/blob/main/docs/AUTOMATIONS.md" target="_blank" rel="noreferrer">docs/AUTOMATIONS.md</a>.</div>
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
                    <div className="flex items-center gap-1"><code className="font-mono text-[11px] truncate flex-1">{s?.webhookUrl}</code><button onClick={() => { void copyText(s?.webhookUrl || ''); toast.success('Webhook URL copied'); }} className="btn btn-ghost btn-sm !px-1"><Copy size={12} /></button></div>
                  </div>
                  <button onClick={() => whoami.mutate()} disabled={!s?.accessTokenSet} className="btn btn-sm"><RefreshCw size={13} className={cn(whoami.isPending && 'animate-spin')} /> Test connection</button>
                  <a href="/settings#integrations" className="btn btn-sm">Enter credentials <ArrowRight size={13} /></a>
                  <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm text-muted"><ExternalLink size={12} /> Meta for Developers</a>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const ERROR_TEXT: Record<string, string> = {
  denied: 'You cancelled the Instagram login. Nothing was connected.',
  access_denied: 'You cancelled the Instagram login. Nothing was connected.',
  state: 'The connect link expired (it is valid for 10 minutes). Try again.',
  bad_state: 'The connect link expired (it is valid for 10 minutes). Try again.',
  token: 'Instagram did not hand back a token. Try again in a minute.',
  not_configured: 'Instagram connect is not configured on this server.',
  profile: 'Connected, but Instagram did not return the profile — reconnect once more.',
  not_professional: 'This account is not a professional (Business/Creator) account. Switch it in Instagram → Settings → Account type, then reconnect.',
};

/** One saved rule, as a row: what fires it, what goes out, how often, and the last error Instagram returned. */
function RuleRow({ r, index, onEdit, onToggle, onDelete }: { r: AutomationRule; index: number; onEdit: () => void; onToggle: () => void; onDelete: () => void }) {
  const family = familyOf(r.trigger_type);
  const Icon = FAMILY_ICON[family];
  const keywords = parseKeywords(r.keywords);
  const mediaIds = parseMediaIds(r.media_ids);
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index, 8) * 0.03 }} className={cn('card p-4 flex flex-wrap items-start gap-x-4 gap-y-3', !r.enabled && 'opacity-60', r.last_error && 'border-danger/40')}>
      <div className={cn('mt-0.5 h-8 w-8 shrink-0 grid place-items-center rounded-lg', family === 'comment' ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent')}><Icon size={16} /></div>
      {/* min-w keeps the controls beside the text on a laptop and drops them onto their own line on a phone */}
      <div className="min-w-[240px] flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[14px] font-medium">{r.name}</span>
          {!r.enabled && <span className="chip !py-[3px] !text-[11px]">off</span>}
          {mediaIds.length ? <span className="chip !py-[3px] !text-[11px]"><Images size={11} /> {mediaIds.length} post{mediaIds.length === 1 ? '' : 's'}</span> : null}
          {r.once_per_person ? <span className="chip !py-[3px] !text-[11px]"><UserCheck size={11} /> once per person</span> : null}
        </div>
        <div className="mt-1 text-[12.5px] text-muted">{triggerSentence(family, keywords, mediaIds.length)} · {r.match_mode.replace('_', ' ')}</div>
        <div className="mt-1.5 text-[12.5px] text-ink-2 clamp-2 whitespace-pre-wrap">↳ {r.reply_text}{r.reply_link ? ` ${r.reply_link}` : ''}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 text-[11px] text-muted font-mono">
          <span>{r.hit_count} hits{r.last_hit_at ? ` · last ${fmtAgo(r.last_hit_at)}` : ''}</span>
          <span className="inline-flex items-center gap-1"><Timer size={10} /> {fmtCooldown(r.cooldown_minutes)}</span>
          <span>priority {r.priority}</span>
        </div>
        {r.last_error ? (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger-soft/50 px-2.5 py-1.5 text-[12px] text-danger break-words">
            <TriangleAlert size={11} className="mr-1 -mt-0.5 inline" />
            Last send failed{r.last_error_at ? ` ${fmtAgo(r.last_error_at)}` : ''} — Instagram said: {r.last_error}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1 shrink-0 ml-auto">
        <Toggle checked={!!r.enabled} onChange={onToggle} ariaLabel={`${r.name}: ${r.enabled ? 'on' : 'off'}`} />
        <button onClick={onEdit} className="btn btn-ghost btn-sm !px-1.5" aria-label={`Edit ${r.name}`}><Pencil size={14} /></button>
        <button onClick={onDelete} className="btn btn-ghost btn-sm !px-1.5 text-danger" aria-label={`Delete ${r.name}`}><Trash2 size={14} /></button>
      </div>
    </motion.div>
  );
}

export default function Automations() {
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const status = useQuery({ queryKey: ['auto-status'], queryFn: () => api.get<any>('/api/automations/status') });
  const rules = useRules();
  const events = useAutomationEvents(200);
  const account = useIgAccount();
  const [builder, setBuilder] = useState<RuleDraft | null>(null);
  const [tab, setTab] = useState<'rules' | 'log'>('rules');
  const { plan, openUpgrade } = useQuota();
  const metered = !!plan && plan.plan !== 'owner';
  const rulesFull = metered && meterFull(plan!.usage?.rules);
  const list = rules.data?.rules ?? [];

  const openBuilder = (draft: RuleDraft) => {
    if (!draft.id && rulesFull) { openUpgrade({ quota: { error: 'Rule limit reached', code: 'quota', metric: 'rules', used: plan!.usage.rules.used, limit: plan!.usage.rules.limit, plan: plan!.effectivePlan, upgrade: true } }); return; }
    setBuilder(draft);
  };

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: RULES_KEY });
    void qc.invalidateQueries({ queryKey: ['auto-status'] });
    void qc.invalidateQueries({ queryKey: ['plan'] });
    void qc.invalidateQueries({ queryKey: ['starter-rules'] });
    void qc.invalidateQueries({ queryKey: DIAGNOSTICS_KEY });
  };
  const del = useMutation({ mutationFn: (id: number) => api.del(`/api/automations/rules/${id}`), onSuccess: () => { invalidate(); toast.success('Rule deleted'); } });
  const toggle = useMutation({ mutationFn: (r: AutomationRule) => api.put(`/api/automations/rules/${r.id}`, { enabled: !r.enabled }), onSuccess: () => invalidate() });
  const s = status.data;

  // ?connected=1 / ?error=… after the OAuth callback (ROUND5-SPEC §1) → toast once, then clean the URL.
  useEffect(() => {
    const connected = sp.get('connected'); const err = sp.get('error');
    if (!connected && !err) return;
    if (connected) { toast.success('Instagram connected — three starter rules are waiting below (off until you switch them on).', { duration: 7000 }); qc.invalidateQueries({ queryKey: ['ig-account'] }); qc.invalidateQueries({ queryKey: ['auto-status'] }); qc.invalidateQueries({ queryKey: RULES_KEY }); qc.invalidateQueries({ queryKey: ['starter-rules'] }); qc.invalidateQueries({ queryKey: DIAGNOSTICS_KEY }); }
    if (err) toast.error(ERROR_TEXT[err] || `Instagram connect failed: ${err.replace(/[_-]/g, ' ')}`, { duration: 9000 });
    const next = new URLSearchParams(sp); next.delete('connected'); next.delete('error'); setSp(next, { replace: true });
  }, [sp, setSp, qc]);

  const latestSenderId = useMemo(() => { const ev = (events.data ?? []).find((e) => e.direction === 'in' && e.sender_id); return ev ? String(ev.sender_id) : null; }, [events.data]);
  const oauthConnected = !!account.data?.connected && account.data?.source === 'oauth';
  const showOwnApp = !oauthConnected && (!!s?.accessTokenSet || !!s?.verifyTokenSet || !account.data?.configured);

  return (
    <div>
      <PageHeader
        eyebrow="Automations"
        title={<>Instagram DM <em className="text-accent not-italic">autopilot</em></>}
        subtitle="Auto-replies to comments, DMs and story replies through Meta’s official Instagram messaging API. Pick the trigger, pick the post, write the DM, test it — all in this app."
        actions={<button onClick={() => openBuilder({ ...EMPTY_DRAFT })} className="btn btn-primary"><Plus size={14} /> New rule</button>}
      />

      {/* Connection */}
      <div className="mb-6">
        <ConnectCard />
        {showOwnApp && <OwnAppSetup s={s} />}
      </div>

      {/* Health first: why an automation can or cannot fire */}
      <HealthCard className="mb-6" />

      {metered && plan && (
        <div className={cn('card-flat p-4 mb-8 grid sm:grid-cols-[1fr_1fr_auto] gap-x-6 gap-y-3 items-center', (rulesFull || meterFull(plan.usage?.sends) || plan.effectivePlan === 'free') && 'border-warn/40')}>
          <UsageBar label="Automation rules" meter={plan.usage?.rules} hint={rulesFull ? 'Rule limit reached — upgrade to add more' : undefined} />
          <UsageBar label="Automated replies this month" meter={plan.usage?.sends} hint={plan.effectivePlan === 'free' ? 'Automations are paused on the free plan' : meterFull(plan.usage?.sends) ? 'Send limit reached — replies are skipped until next month' : undefined} />
          <button onClick={() => openUpgrade()} className="btn btn-sm justify-self-start sm:justify-self-end"><Zap size={13} className="text-accent" /> More on Pro / Studio</button>
        </div>
      )}

      {/* Quick start — the three templates, each opening the builder prefilled */}
      <QuickStart rules={list} latestSenderId={latestSenderId} onOpenBuilder={openBuilder} className="mb-8" />

      {/* Rules / activity */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow mb-1">Rules and activity</div>
          <h2 className="display text-[22px]">{tab === 'rules' ? 'All rules' : 'Activity log'}</h2>
          <div className="text-[12.5px] text-muted">{tab === 'rules' ? 'Rules run top-down by priority; the first match wins.' : 'Every DM, comment and story reply that came in, with the reply that went out.'}</div>
        </div>
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'rules', label: `Rules (${list.length})` }, { id: 'log', label: `Activity (${s?.events24h ?? 0} today)` }]} />
      </div>

      {tab === 'rules' && (
        list.length ? (
          <div className="space-y-2">
            {list.map((r, i) => (
              <RuleRow
                key={r.id} r={r} index={i}
                onEdit={() => setBuilder(draftFromRule(r))}
                onToggle={() => toggle.mutate(r)}
                onDelete={() => { if (confirm(`Delete “${r.name}”? The activity it already logged stays.`)) del.mutate(r.id); }}
              />
            ))}
          </div>
        ) : (
          <Empty icon={<Bot size={28} />} title="No rules yet" body="Switch on one of the three quick-start rules above, or build your own: pick a trigger, pick the post, write the DM." action={<button onClick={() => openBuilder({ ...EMPTY_DRAFT })} className="btn"><Plus size={14} /> Build a rule</button>} />
        )
      )}

      {tab === 'log' && (
        // history stays readable after a disconnect, so the log also shows whenever there are past events
        (oauthConnected || s?.configured || (events.data?.length ?? 0) > 0) ? (
          <ActivityLog rules={list} connected={oauthConnected || !!s?.configured} onSimulate={() => openBuilder(list[0] ? draftFromRule(list[0]) : { ...EMPTY_DRAFT })} />
        ) : (
          <Empty
            icon={<MessageSquare size={26} />}
            title="Connect Instagram to see activity"
            body="Once connected, every DM, comment and story reply is listed here with the reply that went out."
            action={account.data?.configured ? <button onClick={startInstagramConnect} className="btn btn-primary">Connect Instagram <ArrowRight size={13} /></button> : <a href="/settings#integrations" className="btn">Enter Meta credentials <ArrowRight size={13} /></a>}
          />
        )
      )}

      {builder && (
        <RuleBuilder
          draft={builder}
          rules={list}
          accountUsername={account.data?.account?.username ?? null}
          latestSenderId={latestSenderId}
          onClose={() => setBuilder(null)}
        />
      )}
    </div>
  );
}
