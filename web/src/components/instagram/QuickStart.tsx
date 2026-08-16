import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { MessageCircle, MessageSquare, Clapperboard, Send, Save, Pencil, Zap, Check, ChevronDown, FlaskConical } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import type { Rule } from '../../lib/types';
import type { StarterKey, StarterRulesResponse } from '../../lib/types-instagram';
import { useQuota } from '../../lib/store';
import { meterFull } from '../../lib/plans';
import { cn } from '../../lib/utils';
import { Toggle } from '../ui';

/** Mirrors server/src/services/instagram.ts STARTER_TEMPLATES (names + trigger types are how we bind cards to rules). */
export interface StarterTemplate { key: StarterKey; name: string; /** "When …" — what triggers it */ when: string; /** "Then …" — what goes out */ then: string; triggerType: Rule['trigger_type']; keywords: string[]; reply: string; publicReply?: string; icon: typeof MessageCircle; testKind: 'comment' | 'dm' | 'story_reply' }
export const STARTERS: StarterTemplate[] = [
  { key: 'comment_link', name: 'Comment keyword → DM the link', when: 'someone comments one of the keywords on any of your posts', then: 'they get a private DM with your link', triggerType: 'comment_keyword', keywords: ['link', 'send', 'guide'], reply: "Hey {{username}} — here's the link you asked for: <paste your link>", publicReply: 'Sent you a DM ✉️', icon: MessageCircle, testKind: 'comment' },
  { key: 'dm_welcome', name: 'First DM → welcome', when: 'someone opens a DM with hi, hello or hey', then: 'they get a short welcome', triggerType: 'dm_keyword', keywords: ['hi', 'hello', 'hey'], reply: 'Hey {{username}}, thanks for writing! I read every message and answer as soon as I can. What can I help you with?', icon: MessageSquare, testKind: 'dm' },
  { key: 'story_thanks', name: 'Story reply → thanks', when: 'someone replies to your story (every reply, or only ones with your keywords)', then: 'they get a thank-you DM', triggerType: 'story_reply', keywords: [], reply: 'Thanks for replying to my story, {{username}}! I read every reply — what did you think?', icon: Clapperboard, testKind: 'story_reply' },
];
const DEFAULT_COOLDOWN: Record<StarterKey, number> = { comment_link: 1440, dm_welcome: 10080, story_thanks: 1440 };
const DEFAULT_PRIORITY: Record<StarterKey, number> = { comment_link: 10, dm_welcome: 50, story_thanks: 60 };
/** "once a day per person" — the cooldown in words for the When / Then line. */
export function fmtCooldown(min: number): string {
  if (!min || min <= 0) return 'every time';
  if (min < 60) return `at most once every ${min} min per person`;
  if (min < 1440) return `at most once every ${Math.round(min / 60)} h per person`;
  if (min === 1440) return 'once a day per person';
  if (min === 10080) return 'once a week per person';
  return `at most once every ${Math.round(min / 1440)} days per person`;
}
const NAME_RX: Record<StarterKey, RegExp> = { comment_link: /comment keyword|dm the link/i, dm_welcome: /first dm|welcome/i, story_thanks: /story reply|thanks/i };

const parseKw = (s: string | null | undefined): string[] => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
const sameKw = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x.toLowerCase() === (b[i] || '').toLowerCase());

/** Which existing rule (if any) a starter card is bound to: server mapping first, then name, then "same trigger + same default keywords". */
export function bindStarter(tpl: StarterTemplate, rules: Rule[], mapping?: Partial<Record<StarterKey, number>>): Rule | null {
  const byMap = mapping?.[tpl.key]; if (byMap) { const r = rules.find((x) => x.id === byMap); if (r) return r; }
  const byName = rules.find((r) => r.trigger_type === tpl.triggerType && NAME_RX[tpl.key].test(r.name));
  if (byName) return byName;
  return rules.find((r) => r.trigger_type === tpl.triggerType && sameKw(parseKw(r.keywords), tpl.keywords)) ?? null;
}

function StarterCard({ tpl, rule, latestSenderId, onEditAll, canCreate, onBlockedCreate }: { tpl: StarterTemplate; rule: Rule | null; latestSenderId: string | null; onEditAll: (r: Rule) => void; canCreate: boolean; onBlockedCreate: () => void }) {
  const qc = useQueryClient();
  const initialKw = rule ? parseKw(rule.keywords).join(', ') : tpl.keywords.join(', ');
  const initialReply = rule ? rule.reply_text : tpl.reply;
  const [kw, setKw] = useState(initialKw);
  const [reply, setReply] = useState(initialReply);
  const [testOpen, setTestOpen] = useState(false);
  const [recipient, setRecipient] = useState(latestSenderId || '');
  useEffect(() => { setKw(initialKw); setReply(initialReply); }, [initialKw, initialReply]);
  useEffect(() => { if (latestSenderId && !recipient) setRecipient(latestSenderId); }, [latestSenderId]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = kw !== initialKw || reply !== initialReply;
  const enabled = !!rule?.enabled;
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['rules'] }); qc.invalidateQueries({ queryKey: ['auto-status'] }); qc.invalidateQueries({ queryKey: ['plan'] }); qc.invalidateQueries({ queryKey: ['starter-rules'] }); };
  const cooldown = rule?.cooldown_minutes ?? DEFAULT_COOLDOWN[tpl.key];
  const body = (en: boolean) => ({ name: rule?.name || tpl.name, trigger_type: tpl.triggerType, match_mode: rule?.match_mode || 'contains', keywords: kw.split(',').map((s) => s.trim()).filter(Boolean), reply_text: reply, reply_link: rule?.reply_link ?? '', public_reply_text: rule?.public_reply_text ?? tpl.publicReply ?? '', cooldown_minutes: cooldown, priority: rule?.priority ?? DEFAULT_PRIORITY[tpl.key], enabled: en });
  const save = useMutation({
    mutationFn: (en: boolean) => (rule ? api.put(`/api/automations/rules/${rule.id}`, body(en)) : api.post('/api/automations/rules', body(en))),
    onSuccess: (_r, en) => { toast.success(rule ? (en !== enabled ? (en ? `${tpl.name} is on` : `${tpl.name} is off`) : 'Saved') : `${tpl.name} created${en ? ' and switched on' : ''}`); invalidate(); },
    onError: (e: any) => { if (e?.status !== 402) toast.error(e?.message || 'Could not save'); },
  });
  const sendTest = useMutation({
    mutationFn: () => api.post<any>('/api/automations/send-test', { recipient_id: recipient.trim(), text: reply.replace(/\{\{\s*username\s*\}\}/g, 'you') }),
    onSuccess: (r) => (r?.ok ? toast.success('Test DM sent — check your Instagram inbox') : toast.error(r?.message || 'Instagram refused the test message')),
    onError: (e: any) => { if (e?.status !== 402) toast.error(e?.message || 'Could not send'); },
  });
  const dryRun = useMutation({
    mutationFn: () => api.post<any>('/api/automations/test', { kind: tpl.testKind, text: kw.split(',')[0]?.trim() || 'hello' }),
    onSuccess: (r) => (r?.matched ? toast.success(`Would fire: ${r.matched.name}`) : toast('No enabled rule matches that text yet' + (rule && !enabled ? ' — this one is off' : ''))),
  });
  const onToggle = (v: boolean) => { if (!rule && !canCreate) { onBlockedCreate(); return; } save.mutate(v); };

  return (
    <motion.div layout className={cn('card p-4 flex flex-col gap-3 min-w-0', enabled && 'border-accent/40')}>
      <div className="flex items-start gap-3">
        <span className={cn('mt-0.5 h-8 w-8 shrink-0 grid place-items-center rounded-lg', tpl.testKind === 'comment' ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent')}><tpl.icon size={15} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap"><span className="text-[14px] font-medium">{tpl.name}</span>{rule ? <span className={cn('chip !text-[10.5px]', enabled ? 'chip-active' : 'text-muted')}>{enabled ? <><Check size={10} /> on</> : 'off'}</span> : <span className="chip !text-[10.5px] text-muted">not added</span>}</div>
        </div>
        <span title={enabled ? 'Switch off' : 'Switch on'}><Toggle checked={enabled} onChange={onToggle} /></span>
      </div>
      <dl className="grid grid-cols-[38px_1fr] gap-x-2 gap-y-1 text-[12px] leading-relaxed">
        <dt className="font-mono text-[10.5px] uppercase tracking-wider text-muted pt-[3px]">When</dt><dd className="text-ink-2">{tpl.when}</dd>
        <dt className="font-mono text-[10.5px] uppercase tracking-wider text-muted pt-[3px]">Then</dt><dd className="text-ink-2">{tpl.then}, {fmtCooldown(cooldown)}</dd>
      </dl>
      <label className="block">
        <span className="text-[11.5px] font-medium text-ink-2">Keyword{tpl.triggerType === 'story_reply' ? 's (optional)' : 's'}</span>
        <input value={kw} onChange={(e) => setKw(e.target.value)} className="input mt-1 font-mono text-[12px]" placeholder={tpl.triggerType === 'story_reply' ? 'leave empty for every reply' : 'link, send, guide'} />
      </label>
      <label className="block">
        <span className="text-[11.5px] font-medium text-ink-2">Reply {tpl.testKind === 'comment' ? '(private DM)' : ''}</span>
        <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3} className="input mt-1 text-[12.5px]" />
      </label>
      <div className="flex flex-wrap items-center gap-1.5 mt-auto">
        {dirty && <button onClick={() => { if (!rule && !canCreate) { onBlockedCreate(); return; } save.mutate(enabled); }} disabled={save.isPending} className="btn btn-primary btn-sm"><Save size={12} /> {save.isPending ? 'Saving…' : rule ? 'Save changes' : 'Add rule'}</button>}
        <button onClick={() => setTestOpen((o) => !o)} className="btn btn-sm" aria-expanded={testOpen}><Send size={12} /> Send me a test <ChevronDown size={11} className={cn('transition-transform', testOpen && 'rotate-180')} /></button>
        <button onClick={() => dryRun.mutate()} disabled={dryRun.isPending} className="btn btn-ghost btn-sm text-muted" title="Check which rule would answer the first keyword. Nothing is sent."><FlaskConical size={12} /> Dry run</button>
        {rule && <button onClick={() => onEditAll(rule)} className="btn btn-ghost btn-sm text-muted ml-auto"><Pencil size={12} /> All options</button>}
      </div>
      <AnimatePresence initial={false}>
        {testOpen && (
          <motion.div key="test" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="rounded-xl border border-line bg-surface-2/60 p-3 text-[12px]">
              <div className="text-muted leading-relaxed mb-2">Instagram only lets an app DM people who have messaged you first. Paste the sender id of any recent DM (prefilled from your activity log when there is one); the reply above goes there as a real message.</div>
              <div className="flex flex-wrap gap-2">
                <input value={recipient} onChange={(e) => setRecipient(e.target.value)} className="input font-mono text-[12px] flex-1 min-w-[180px]" placeholder="IG-scoped sender id, e.g. 1784…" />
                <button onClick={() => sendTest.mutate()} disabled={!recipient.trim() || sendTest.isPending} className="btn btn-primary btn-sm"><Send size={12} /> {sendTest.isPending ? 'Sending…' : 'Send'}</button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/**
 * "Quick start": the 3 starter templates as editable cards bound to the tenant's starter rules (ROUND5-SPEC §2).
 * Cards work before the rules exist (Enable/Add creates them) and after (edits go straight to the rule).
 */
export function QuickStart({ rules, latestSenderId, onEditAll, className }: { rules: Rule[]; latestSenderId: string | null; onEditAll: (r: Rule) => void; className?: string }) {
  const qc = useQueryClient();
  const { plan, openUpgrade } = useQuota();
  const metered = !!plan && plan.plan !== 'owner';
  const rulesFull = metered && meterFull(plan!.usage?.rules);
  const blocked = () => openUpgrade({ quota: { error: 'Rule limit reached', code: 'quota', metric: 'rules', used: plan!.usage.rules.used, limit: plan!.usage.rules.limit, plan: plan!.effectivePlan, upgrade: true } });
  // Server-side mapping (starter key → rule id) when the server exposes it read-only; falls back to name/trigger binding.
  const mapping = useQuery({
    queryKey: ['starter-rules'],
    queryFn: async () => { try { const r = await api.get<StarterRulesResponse<Rule> | string>('/api/automations/starter'); const m: Partial<Record<StarterKey, number>> = {}; if (r && typeof r === 'object') for (const x of r.rules || []) if (x?.starter_key) m[x.starter_key] = x.id; return m; } catch (e) { if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return {} as Partial<Record<StarterKey, number>>; throw e; } },
    staleTime: 60_000, retry: false,
  });
  const bound = useMemo(() => STARTERS.map((tpl) => ({ tpl, rule: bindStarter(tpl, rules, mapping.data) })), [rules, mapping.data]);
  const missing = bound.filter((b) => !b.rule).length;
  const addAll = useMutation({
    mutationFn: () => api.post<StarterRulesResponse<Rule>>('/api/automations/starter'),
    onSuccess: (r) => { toast.success(r?.created ? `Added ${r.created} starter rule${r.created === 1 ? '' : 's'} (off until you switch them on)` : 'Starter rules are already there'); if (r?.leftOut) toast(`${r.leftOut} did not fit your plan's rule limit`, { action: { label: 'Upgrade', onClick: () => openUpgrade() } }); qc.invalidateQueries({ queryKey: ['rules'] }); qc.invalidateQueries({ queryKey: ['starter-rules'] }); qc.invalidateQueries({ queryKey: ['plan'] }); },
    onError: (e: any) => { if (e?.status === 402) return; toast.error(e?.status === 404 ? 'This server has no starter endpoint yet — use Enable on a card instead.' : e?.message || 'Could not add starter rules'); },
  });
  return (
    <section className={className}>
      <div className="flex flex-wrap items-end justify-between gap-2 mb-3">
        <div><div className="eyebrow mb-1">Quick start</div><h2 className="display text-[22px]">Three rules most creators want</h2><div className="text-[12.5px] text-muted">Change the keywords and the reply, then switch on. Cooldown, priority and the link live under “All options”.</div></div>
        {missing > 0 && <button onClick={() => (rulesFull ? blocked() : addAll.mutate())} disabled={addAll.isPending} className="btn btn-sm"><Zap size={13} className="text-accent" /> {addAll.isPending ? 'Adding…' : missing === 3 ? 'Add all three (off)' : `Add the missing ${missing} (off)`}</button>}
      </div>
      <div className="grid md:grid-cols-3 gap-3">
        {bound.map(({ tpl, rule }) => <StarterCard key={tpl.key} tpl={tpl} rule={rule} latestSenderId={latestSenderId} onEditAll={onEditAll} canCreate={!rulesFull} onBlockedCreate={blocked} />)}
      </div>
    </section>
  );
}
