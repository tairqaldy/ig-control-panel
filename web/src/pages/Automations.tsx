import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { ArrowRight, CheckCircle2, ChevronDown, Copy, ExternalLink, MessageSquare, Plus, RefreshCw, Sparkles, XCircle, Zap } from 'lucide-react';
import { api } from '../lib/api';
import {
  type AutomationRule, type RuleDraft, type RulesResponse,
  EMPTY_DRAFT, draftFromRule, ruleBody,
} from '../lib/types-automations';
import { useQuota } from '../lib/store';
import { meterFull } from '../lib/plans';
import { PageHeader, Tabs, Empty, Skeleton } from '../components/ui';
import { UsageBar } from '../components/Pricing';
import { ConnectCard, useIgAccount, startInstagramConnect } from '../components/instagram';
import { HealthCard } from '../components/instagram/HealthCard';
import { RuleBuilder } from '../components/instagram/RuleBuilder';
import { RuleList } from '../components/instagram/RuleList';
import { TemplateGallery } from '../components/instagram/Templates';
import { LiveActivity } from '../components/instagram/LiveActivity';
import { IgAvailabilityNotice } from '../components/instagram/IgAvailabilityNotice';
import { ActivityLog } from '../components/instagram/ActivityLog';
import { DIAGNOSTICS_KEY, RULES_KEY, useAutomationEvents, useIgAvailability, useRules } from '../components/instagram/useAutomations';
import { cn, copyText } from '../lib/utils';

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

/** What the builder opens with: the draft, and whether a template already decided everything above "Then". */
interface BuilderState { draft: RuleDraft; focus?: 'then' }

const WEEK = 7 * 86400;

export default function Automations() {
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const status = useQuery({ queryKey: ['auto-status'], queryFn: () => api.get<any>('/api/automations/status') });
  const rules = useRules();
  const events = useAutomationEvents(200);
  const account = useIgAccount();
  const availability = useIgAvailability();
  const [builder, setBuilder] = useState<BuilderState | null>(null);
  const [tab, setTab] = useState<'rules' | 'log'>('rules');
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const { plan, openUpgrade } = useQuota();
  const metered = !!plan && plan.plan !== 'owner';
  const rulesFull = metered && meterFull(plan!.usage?.rules);
  const list = rules.data?.rules ?? [];
  const s = status.data;

  const blockedCreate = () => openUpgrade({ quota: { error: 'Rule limit reached', code: 'quota', metric: 'rules', used: plan!.usage.rules.used, limit: plan!.usage.rules.limit, plan: plan!.effectivePlan, upgrade: true } });
  const openBuilder = (draft: RuleDraft, focus?: 'then') => {
    if (!draft.id && rulesFull) { blockedCreate(); return; }
    setBuilder({ draft, focus });
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
  const duplicate = useMutation({
    mutationFn: (r: AutomationRule) => api.post('/api/automations/rules', { ...ruleBody(draftFromRule(r)), name: `${r.name} (copy)`.slice(0, 80), enabled: false, priority: (r.priority ?? 100) + 1 }),
    onSuccess: () => { invalidate(); toast.success('Copied — the duplicate is off until you switch it on'); },
    onError: (e: any) => { if (e?.status !== 402) toast.error(e?.message || 'Could not duplicate the rule'); },
  });

  /** Drag or ↑/↓ hands back the new order; priorities are rewritten 10, 20, 30 … so the gaps stay editable. */
  const reorder = useMutation({
    mutationFn: async (ids: number[]) => {
      const byId = new Map(list.map((r) => [r.id, r]));
      const writes = ids
        .map((id, i) => ({ id, rule: byId.get(id), priority: (i + 1) * 10 }))
        .filter((x) => x.rule && x.rule.priority !== x.priority)
        .map((x) => api.put(`/api/automations/rules/${x.id}`, { priority: x.priority }));
      await Promise.all(writes);
    },
    onMutate: async (ids: number[]) => {
      await qc.cancelQueries({ queryKey: RULES_KEY });
      const prev = qc.getQueryData<RulesResponse>(RULES_KEY);
      if (prev) {
        const byId = new Map(prev.rules.map((r) => [r.id, r]));
        const moved = ids.map((id, i) => { const r = byId.get(id); return r ? { ...r, priority: (i + 1) * 10 } : null; }).filter((r): r is AutomationRule => !!r);
        const rest = prev.rules.filter((r) => !ids.includes(r.id)); // a rule added by another tab mid-drag
        qc.setQueryData<RulesResponse>(RULES_KEY, { ...prev, rules: [...moved, ...rest] });
      }
      return { prev };
    },
    onError: (e: any, _ids, ctx) => { if (ctx?.prev) qc.setQueryData(RULES_KEY, ctx.prev); toast.error(e?.message || 'Could not save the new order'); },
    onSettled: () => { void qc.invalidateQueries({ queryKey: RULES_KEY }); },
  });

  // ?connected=1 / ?error=… after the OAuth callback (ROUND5-SPEC §1) → toast once, then clean the URL.
  useEffect(() => {
    const connected = sp.get('connected'); const err = sp.get('error');
    if (!connected && !err) return;
    if (connected) { toast.success('Instagram connected — three starter rules are waiting below (off until you switch them on).', { duration: 7000 }); qc.invalidateQueries({ queryKey: ['ig-account'] }); qc.invalidateQueries({ queryKey: ['auto-status'] }); qc.invalidateQueries({ queryKey: RULES_KEY }); qc.invalidateQueries({ queryKey: ['starter-rules'] }); qc.invalidateQueries({ queryKey: DIAGNOSTICS_KEY }); }
    if (err) toast.error(ERROR_TEXT[err] || `Instagram connect failed: ${err.replace(/[_-]/g, ' ')}`, { duration: 9000 });
    const next = new URLSearchParams(sp); next.delete('connected'); next.delete('error'); setSp(next, { replace: true });
  }, [sp, setSp, qc]);

  const latestSenderId = useMemo(() => { const ev = (events.data ?? []).find((e) => e.direction === 'in' && e.sender_id); return ev ? String(ev.sender_id) : null; }, [events.data]);

  /** Replies each rule sent in the last 7 days, from the activity we have loaded (200 events). */
  const { sendsThisWeek, sendsPartial } = useMemo(() => {
    const evs = events.data ?? [];
    const cutoff = Math.floor(Date.now() / 1000) - WEEK;
    const m = new Map<number, number>();
    for (const e of evs) {
      if (e.direction !== 'out' || !e.rule_id || e.status === 'error' || e.ts < cutoff) continue;
      m.set(e.rule_id, (m.get(e.rule_id) ?? 0) + 1);
    }
    // the window ends before the week does, so the counts are a floor
    const oldest = evs.length ? evs[evs.length - 1].ts : 0;
    return { sendsThisWeek: m, sendsPartial: evs.length >= 200 && oldest > cutoff };
  }, [events.data]);

  const oauthConnected = !!account.data?.connected && account.data?.source === 'oauth';
  const canSend = oauthConnected || !!s?.configured;
  const av = availability.data;
  const avKnown = !!av && !av.unavailable;
  const cannotConnect = avKnown && !av.canConnect && !canSend;
  const showOwnApp = !oauthConnected && (!!s?.accessTokenSet || !!s?.verifyTokenSet || !account.data?.configured);

  /* Never offer a real send that cannot work — say why instead (ROUND7-SPEC §3). */
  const sendBlockedReason = canSend
    ? null
    : cannotConnect
      ? `${av!.reason || 'Instagram accounts cannot be connected yet.'} Everything else here — the builder, templates and Simulate — works now.`
      : 'Connect Instagram first; a real test send needs a live connection. Simulate works without one.';

  /* The live feed's empty state: quiet because nothing can arrive, not because the feed is broken. */
  const quietReason = canSend ? null : cannotConnect
    ? 'Nothing can arrive yet: Instagram only delivers messages to a connected account. Your rules are saved and will run from the moment that changes.'
    : 'Nothing can arrive until Instagram is connected. Your rules are saved and will run from the moment it is.';

  return (
    <div>
      <PageHeader
        eyebrow="Automations"
        title={<>Instagram DM <em className="text-accent not-italic">autopilot</em></>}
        subtitle="Auto-replies to comments, DMs and story replies through Meta’s official Instagram messaging API. Pick the trigger, pick the post, write the DM, test it — all in this app."
        actions={<button onClick={() => openBuilder({ ...EMPTY_DRAFT })} className="btn btn-primary"><Plus size={14} /> New rule</button>}
      />

      {/* Connection — or, when connecting is impossible today, what is possible instead */}
      <div className="mb-6">
        {cannotConnect ? (
          <IgAvailabilityNotice availability={av!} stillWorks="Rules, templates and the simulator all work now. Nothing is sent to anyone until an account is connected." />
        ) : (
          /* ConnectCard consults availability itself and renders the neutral "checking…" state while the Meta probe
             is in flight, so the first load after a restart no longer shows a live Connect button for six seconds. */
          <ConnectCard />
        )}
        {/* self-hosters still need the credentials checklist, including when the hosted path is closed */}
        {showOwnApp && <OwnAppSetup s={s} />}
      </div>

      {/* Health first: why an automation can or cannot fire. It gets the builder so its "Add a rule" fix opens one
          instead of reloading this page, and it consults availability itself so it cannot offer the Connect button
          the notice above just ruled out. */}
      <HealthCard className="mb-6" onAddRule={() => openBuilder({ ...EMPTY_DRAFT })} />

      {metered && plan && (
        <div className={cn('card-flat p-4 mb-8 grid sm:grid-cols-[1fr_1fr_auto] gap-x-6 gap-y-3 items-center', (rulesFull || meterFull(plan.usage?.sends) || plan.effectivePlan === 'free') && 'border-warn/40')}>
          <UsageBar label="Automation rules" meter={plan.usage?.rules} hint={rulesFull ? 'Rule limit reached — upgrade to add more' : undefined} />
          <UsageBar label="Automated replies this month" meter={plan.usage?.sends} hint={plan.effectivePlan === 'free' ? 'Automations are paused on the free plan' : meterFull(plan.usage?.sends) ? 'Send limit reached — replies are skipped until next month' : undefined} />
          <button onClick={() => openUpgrade()} className="btn btn-sm justify-self-start sm:justify-self-end"><Zap size={13} className="text-accent" /> More on Pro / Studio</button>
        </div>
      )}

      {/* Rules / activity */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow mb-1">Rules and activity</div>
          <h2 className="display text-[22px]">{tab === 'rules' ? 'What your account does on its own' : 'Activity log'}</h2>
          <div className="text-[12.5px] text-muted">{tab === 'rules' ? 'Each line is one behaviour. Switch it off and it stops immediately.' : 'Every DM, comment and story reply that came in, with the reply that went out.'}</div>
        </div>
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'rules', label: `Rules (${list.length})` }, { id: 'log', label: `Activity (${s?.events24h ?? 0} today)` }]} />
      </div>

      {tab === 'rules' && (
        // no flash of the templates gallery before we know whether there are rules
        rules.isLoading && !rules.data ? <Skeleton className="h-40" />
        // A failed fetch is not an empty account. Without this, somebody with four live rules was shown "Start here /
        // Pick a behaviour" and invited to build a duplicate of a rule they already own.
        : rules.isError && !rules.data ? (
          <div className="card border-danger/40 p-5">
            <div className="text-[14px] font-medium">Your rules could not be loaded</div>
            <p className="mt-1 text-[12.5px] text-muted leading-relaxed">
              Nothing has changed and nothing was deleted — this page simply could not read them. {(rules.error as Error | null)?.message || ''}
            </p>
            <button onClick={() => { void rules.refetch(); }} disabled={rules.isFetching} className="btn btn-sm mt-3">
              <RefreshCw size={13} className={cn(rules.isFetching && 'animate-spin')} /> Try again
            </button>
          </div>
        ) : list.length ? (
          <>
            <RuleList
              rules={list}
              sendsThisWeek={sendsThisWeek}
              sendsPartial={sendsPartial}
              onEdit={(r) => setBuilder({ draft: draftFromRule(r) })}
              onToggle={(r) => toggle.mutate(r)}
              onDuplicate={(r) => (rulesFull ? blockedCreate() : duplicate.mutate(r))}
              onDelete={(r) => { if (confirm(`Delete “${r.name}”? The activity it already logged stays.`)) del.mutate(r.id); }}
              onReorder={(ids) => reorder.mutate(ids)}
            />

            <div className="mt-6">
              <button onClick={() => setTemplatesOpen((o) => !o)} className="btn btn-sm" aria-expanded={templatesOpen}>
                <Sparkles size={13} className="text-accent" /> Add another behaviour <ChevronDown size={12} className={cn('transition-transform', templatesOpen && 'rotate-180')} />
              </button>
              <AnimatePresence initial={false}>
                {templatesOpen && (
                  <motion.div key="tpl" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                    <TemplateGallery
                      className="pt-4"
                      variant="inline"
                      canCreate={!rulesFull}
                      onBlocked={blockedCreate}
                      onPick={(d) => { setTemplatesOpen(false); openBuilder(d, 'then'); }}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <LiveActivity className="mt-6" rules={list} onSeeAll={() => setTab('log')} quietReason={quietReason} />
          </>
        ) : (
          <>
            <TemplateGallery
              canCreate={!rulesFull}
              onBlocked={blockedCreate}
              onPick={(d) => openBuilder(d, 'then')}
            />
            <div className="mt-4 text-[12.5px] text-muted">
              Nothing here fits?{' '}
              <button onClick={() => openBuilder({ ...EMPTY_DRAFT })} className="text-accent underline underline-offset-2">Build a rule from scratch</button>.
              {!canSend && ' Rules save and can be tested with Simulate before Instagram is connected.'}
            </div>
            {/* someone who deleted their last rule still has history — and "no rule matched" rows are the reason to add one */}
            {(events.data?.length ?? 0) > 0 && (
              <LiveActivity className="mt-6" rules={list} onSeeAll={() => setTab('log')} quietReason={quietReason} />
            )}
          </>
        )
      )}

      {tab === 'log' && (
        // history stays readable after a disconnect, so the log also shows whenever there are past events
        (canSend || (events.data?.length ?? 0) > 0) ? (
          <ActivityLog rules={list} connected={canSend} onSimulate={() => openBuilder(list[0] ? draftFromRule(list[0]) : { ...EMPTY_DRAFT })} />
        ) : (
          <Empty
            icon={<MessageSquare size={26} />}
            title={cannotConnect ? 'Nothing can arrive yet' : 'Connect Instagram to see activity'}
            body={cannotConnect
              ? `${av!.reason || 'Instagram accounts cannot be connected yet.'} Once that changes, every DM, comment and story reply is listed here with the reply that went out.`
              : 'Once connected, every DM, comment and story reply is listed here with the reply that went out.'}
            action={cannotConnect ? undefined : account.data?.configured
              ? <button onClick={startInstagramConnect} className="btn btn-primary">Connect Instagram <ArrowRight size={13} /></button>
              : <a href="/settings#integrations" className="btn">Enter Meta credentials <ArrowRight size={13} /></a>}
          />
        )
      )}

      {builder && (
        <RuleBuilder
          draft={builder.draft}
          rules={list}
          accountUsername={account.data?.account?.username ?? null}
          latestSenderId={latestSenderId}
          focusStep={builder.focus}
          sendBlockedReason={sendBlockedReason}
          onClose={() => setBuilder(null)}
        />
      )}
    </div>
  );
}
