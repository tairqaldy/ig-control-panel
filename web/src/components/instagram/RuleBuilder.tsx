/* Round 6 §2 — the rule builder: When / Where / Then / Limits, with a live DM preview and a test panel.
   Full-height sheet on phones, centred dialog from `sm` up. Unsaved changes are guarded on close. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { CheckCircle2, Clapperboard, FlaskConical, Link2, MessageCircle, MessageSquare, Play, Save, Send, Timer, TriangleAlert, UserCheck, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import {
  type AutomationRule, type RuleDraft, type SimulateResponse, type TestSendResponse, type TriggerFamily,
  MATCH_MODES, TRIGGER_FAMILIES, fmtCooldown, renderReply, ruleBody, triggerSentence,
} from '../../lib/types-automations';
import { Field, Toggle } from '../ui';
import { cn } from '../../lib/utils';
import { DIAGNOSTICS_KEY, RULES_KEY, simulate } from './useAutomations';
import { DmPreview } from './DmPreview';
import { PostPicker } from './PostPicker';

const FAMILY_ICON: Record<TriggerFamily, typeof MessageCircle> = { comment: MessageCircle, dm: MessageSquare, dm_first: UserCheck, story_reply: Clapperboard };
const COOLDOWNS = [
  { min: 0, label: 'Every time' },
  { min: 60, label: 'Once an hour' },
  { min: 1440, label: 'Once a day' },
  { min: 10080, label: 'Once a week' },
];
const simulateKind = (f: TriggerFamily) => (f === 'comment' ? 'comment' : f === 'story_reply' ? 'story_reply' : 'dm') as 'comment' | 'dm' | 'story_reply';

function Step({ n, title, hint, children, sectionRef }: { n: number; title: string; hint?: string; children: React.ReactNode; sectionRef?: React.Ref<HTMLElement> }) {
  return (
    <section ref={sectionRef} className="border-t border-line pt-5 first:border-0 first:pt-0">
      <div className="flex items-baseline gap-2.5">
        <span className="h-5 w-5 shrink-0 grid place-items-center rounded-full border border-line bg-surface-2 font-mono text-[10.5px] text-muted">{n}</span>
        <h4 className="display text-[19px]">{title}</h4>
      </div>
      {hint && <p className="mt-1 ml-[30px] text-[12.5px] text-muted leading-relaxed">{hint}</p>}
      <div className="mt-3 ml-0 sm:ml-[30px]">{children}</div>
    </section>
  );
}

export interface RuleBuilderProps {
  draft: RuleDraft;
  rules: AutomationRule[];
  onClose: () => void;
  accountUsername?: string | null;
  /** prefills the "send a real test" recipient with the last person who messaged you */
  latestSenderId?: string | null;
  /** round 7 §5: a template opens the builder on "Then", where the only thing left to write is the message */
  focusStep?: 'then';
  /** round 7 §5: why a real send cannot happen (not connected, Meta review). Simulating still works. */
  sendBlockedReason?: string | null;
}

export function RuleBuilder({ draft, rules, onClose, accountUsername, latestSenderId, focusStep, sendBlockedReason }: RuleBuilderProps) {
  const qc = useQueryClient();
  const [d, setD] = useState<RuleDraft>(draft);
  const [saved, setSaved] = useState<RuleDraft>(draft);
  const [kwText, setKwText] = useState(draft.keywords.join(', '));
  const [confirmClose, setConfirmClose] = useState(false);
  const [testText, setTestText] = useState(draft.keywords[0] || '');
  const [sim, setSim] = useState<SimulateResponse | null>(null);
  const [recipient, setRecipient] = useState(latestSenderId || '');
  const [sendResult, setSendResult] = useState<TestSendResponse | null>(null);
  const testTouched = useRef(false);
  const thenRef = useRef<HTMLElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  const set = useCallback(<K extends keyof RuleDraft>(k: K, v: RuleDraft[K]) => setD((s) => ({ ...s, [k]: v })), []);
  const onKeywords = (text: string) => { setKwText(text); setD((s) => ({ ...s, keywords: text.split(',').map((x) => x.trim()).filter(Boolean) })); };

  const dirty = useMemo(() => JSON.stringify(d) !== JSON.stringify(saved), [d, saved]);
  const isComment = d.trigger === 'comment';
  const canKeyword = d.trigger !== 'dm_first';
  const family = TRIGGER_FAMILIES.find((f) => f.id === d.trigger)!;
  const problem = !d.replyText.trim() ? 'Write the DM that goes out — step 3.' : !d.name.trim() ? 'Give the rule a name so you can find it later.' : null;

  const requestClose = useCallback(() => { if (dirty) setConfirmClose(true); else onClose(); }, [dirty, onClose]);

  const firstKeyword = d.keywords[0] || '';
  useEffect(() => { if (!testTouched.current) setTestText(firstKeyword); }, [firstKeyword]);

  /* Opened from a template: everything above is already decided, so land on the message. */
  useEffect(() => {
    if (focusStep !== 'then') return;
    const id = requestAnimationFrame(() => {
      thenRef.current?.scrollIntoView({ block: 'start' });
      replyRef.current?.focus();
      replyRef.current?.setSelectionRange(replyRef.current.value.length, replyRef.current.value.length);
    });
    return () => cancelAnimationFrame(id);
  }, [focusStep]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); requestClose(); } };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [requestClose]);

  /** Browser-level guard for reload / tab close while a rule is half-written. */
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const save = useMutation({
    mutationFn: async () => {
      const body = ruleBody(d);
      const r = d.id ? await api.put<{ rule: AutomationRule }>(`/api/automations/rules/${d.id}`, body) : await api.post<{ rule: AutomationRule }>('/api/automations/rules', body);
      return r?.rule;
    },
    onSuccess: (rule) => {
      const next = { ...d, id: rule?.id ?? d.id };
      setD(next); setSaved(next);
      toast.success(d.id ? 'Rule saved' : `Rule created${d.enabled ? ' and switched on' : ' (off until you switch it on)'}`);
      void qc.invalidateQueries({ queryKey: RULES_KEY });
      void qc.invalidateQueries({ queryKey: ['auto-status'] });
      void qc.invalidateQueries({ queryKey: ['starter-rules'] });
      void qc.invalidateQueries({ queryKey: ['plan'] });
      void qc.invalidateQueries({ queryKey: DIAGNOSTICS_KEY });
    },
    // 402 already opened the upgrade modal in api.ts — keep the sheet open so nothing typed is lost.
    onError: (e: any) => { if (e?.status !== 402) toast.error(e?.message || 'Could not save the rule'); },
  });

  const runSim = useMutation({
    mutationFn: () => simulate({ kind: simulateKind(d.trigger), text: testText, mediaId: d.mediaIds[0], senderUsername: 'test_user' }, rules),
    onSuccess: setSim,
    onError: (e: any) => toast.error(e?.message || 'Could not run the simulation'),
  });

  const testSend = useMutation({
    mutationFn: async (): Promise<TestSendResponse> => {
      const to = recipient.trim();
      try {
        return await api.post<TestSendResponse>(`/api/automations/rules/${d.id}/test-send`, { recipient: to });
      } catch (e) {
        if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405 && e.status !== 501)) throw e;
        const legacy = await api.post<{ ok: boolean; message?: string }>('/api/automations/send-test', { recipient_id: to, text: renderReply(d.replyText, d.replyLink, 'you') });
        return { ok: !!legacy?.ok, error: legacy?.ok ? null : legacy?.message || 'Instagram refused the message' };
      }
    },
    onSuccess: (r) => { setSendResult(r); if (r.ok) toast.success('Test DM sent — check your Instagram inbox'); },
    onError: (e: any) => { if (e?.status === 402) return; setSendResult({ ok: false, error: String(e?.message || e) }); },
  });

  const sheet = (
    <motion.div className="fixed inset-0 z-[85] flex sm:items-start sm:justify-center sm:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
      <div className="fixed inset-0 bg-ink/40 dark:bg-black/60 backdrop-blur-[3px]" onClick={requestClose} />
      <motion.div
        role="dialog" aria-modal aria-label={d.id ? 'Edit rule' : 'New rule'}
        className="relative flex h-full w-full flex-col bg-surface sm:my-auto sm:h-auto sm:max-h-[calc(100vh-3rem)] sm:max-w-4xl sm:rounded-2xl sm:border sm:border-line"
        style={{ boxShadow: 'var(--shadow-lg)' }}
        initial={{ opacity: 0, y: 24, scale: 0.99 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.99 }}
        transition={{ type: 'spring', stiffness: 380, damping: 34, mass: 0.8 }}
      >
        {/* header */}
        <div className="flex items-start gap-3 border-b border-line px-4 py-3 sm:px-6 sm:py-4">
          <div className="min-w-0 flex-1">
            <div className="eyebrow mb-1">{d.id ? `Rule #${d.id}` : 'New rule'}</div>
            <input
              value={d.name} onChange={(e) => set('name', e.target.value)} placeholder="Name this rule"
              className="w-full bg-transparent font-serif text-[24px] leading-tight tracking-[-0.01em] text-ink outline-none placeholder:text-muted-2"
              aria-label="Rule name"
            />
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-1">
            <Toggle checked={d.enabled} onChange={(v) => set('enabled', v)} ariaLabel={`Rule ${d.enabled ? 'on' : 'off'}`} />
            <span className="hidden text-[12px] text-muted sm:inline">{d.enabled ? 'On' : 'Off'}</span>
            <button onClick={requestClose} className="btn btn-ghost btn-sm !px-1.5" aria-label="Close"><X size={16} /></button>
          </div>
        </div>

        {/* body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="space-y-5">
              {/* 1 — When */}
              <Step n={1} title="When" hint={family.hint}>
                <div className="flex flex-wrap gap-2">
                  {TRIGGER_FAMILIES.map((f) => {
                    const Icon = FAMILY_ICON[f.id];
                    const on = d.trigger === f.id;
                    return (
                      <button key={f.id} type="button" onClick={() => set('trigger', f.id)} aria-pressed={on} className={cn('chip !py-1.5', on && 'chip-active')}>
                        <Icon size={13} /> {f.label}
                      </button>
                    );
                  })}
                </div>
                {canKeyword && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_170px]">
                    <Field label={d.trigger === 'story_reply' ? 'Keywords (optional)' : 'Keywords'} hint="Comma-separated, case-insensitive. Leave empty to answer every message of this kind.">
                      <input value={kwText} onChange={(e) => onKeywords(e.target.value)} className="input font-mono text-[12.5px]" placeholder="link, guide, send" />
                    </Field>
                    <Field label="Match">
                      <select value={d.matchMode} onChange={(e) => set('matchMode', e.target.value as RuleDraft['matchMode'])} className="input">
                        {MATCH_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                      </select>
                    </Field>
                  </div>
                )}
              </Step>

              {/* 2 — Where */}
              {isComment && (
                <Step n={2} title="Where" hint="Which of your posts this rule watches. Pick the reel you promoted, or leave it on any post.">
                  <PostPicker value={d.mediaIds} onChange={(ids) => set('mediaIds', ids)} />
                </Step>
              )}

              {/* 3 — Then */}
              <Step n={isComment ? 3 : 2} title="Then" hint={isComment ? 'The public comment reply is optional; the DM is the part that carries your link.' : 'This goes out as a direct message from your account.'} sectionRef={thenRef}>
                {isComment && (
                  <Field label="Public comment reply (optional)" hint="Posted under their comment so other people can see you answered.">
                    <input value={d.publicReplyText} onChange={(e) => set('publicReplyText', e.target.value)} className="input" placeholder="Sent you a DM" />
                  </Field>
                )}
                <div className={cn(isComment && 'mt-3')}>
                  <Field label="Direct message" hint={<>Use <code className="font-mono">{'{{username}}'}</code> for their handle{isComment ? ' — a comment can be answered with one private DM, within 7 days' : ''}.</>}>
                    <textarea ref={replyRef} value={d.replyText} onChange={(e) => set('replyText', e.target.value)} rows={4} className="input leading-relaxed" placeholder="Hey {{username}} — here's the link you asked for:" />
                  </Field>
                </div>
                <div className="mt-3">
                  <Field label="Link (optional)" hint="Appended on its own line at the end of the DM.">
                    <div className="relative">
                      <Link2 size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-2" />
                      <input value={d.replyLink} onChange={(e) => set('replyLink', e.target.value)} className="input pl-8" placeholder="https://" />
                    </div>
                  </Field>
                </div>
              </Step>

              {/* 4 — Limits */}
              <Step n={isComment ? 4 : 3} title="Limits" hint="How often the same person can trigger this rule.">
                <div className="flex flex-wrap gap-2">
                  {COOLDOWNS.map((c) => (
                    <button key={c.min} type="button" onClick={() => set('cooldownMinutes', c.min)} aria-pressed={d.cooldownMinutes === c.min} className={cn('chip !py-1.5', d.cooldownMinutes === c.min && 'chip-active')}>
                      <Timer size={12} /> {c.label}
                    </button>
                  ))}
                  <label className="inline-flex items-center gap-1.5 text-[12px] text-muted">
                    <input type="number" min={0} value={d.cooldownMinutes} onChange={(e) => set('cooldownMinutes', Math.max(0, Number(e.target.value) || 0))} className="input !w-24 !py-1.5 text-[12.5px]" aria-label="Cooldown in minutes" />
                    minutes
                  </label>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_150px] sm:items-end">
                  <div className="rounded-xl border border-line bg-surface-2/60 px-3 py-2.5">
                    <Toggle checked={d.oncePerPerson} onChange={(v) => set('oncePerPerson', v)} label="Only ever reply once per person" />
                    <p className="mt-1 text-[12px] text-muted leading-relaxed">Someone who already got this reply never gets it again, whatever the cooldown says.</p>
                  </div>
                  <Field label="Priority" hint="Lower runs first.">
                    <input type="number" value={d.priority} onChange={(e) => set('priority', Number(e.target.value) || 0)} className="input" />
                  </Field>
                </div>
                <p className="mt-3 text-[12.5px] text-muted leading-relaxed">
                  {triggerSentence(d.trigger, d.keywords, d.mediaIds.length)} → they get your DM, {fmtCooldown(d.cooldownMinutes)}
                  {d.oncePerPerson ? ', and only ever once' : ''}.
                </p>
              </Step>
            </div>

            {/* right rail: preview + test */}
            <div className="space-y-4 lg:sticky lg:top-0 lg:self-start">
              <DmPreview
                kind={simulateKind(d.trigger)}
                username="their_handle"
                incoming={testText || d.keywords[0] || (d.trigger === 'story_reply' ? 'love this' : 'link please')}
                text={d.replyText}
                link={d.replyLink}
                publicReply={d.publicReplyText}
                accountUsername={accountUsername}
              />

              <div className="card-flat p-3">
                <div className="eyebrow mb-2">Test</div>
                <label className="block">
                  <span className="text-[11.5px] font-medium text-ink-2">Pretend someone {d.trigger === 'comment' ? 'comments' : d.trigger === 'story_reply' ? 'replies to a story' : 'sends'}</span>
                  <input value={testText} onChange={(e) => { testTouched.current = true; setTestText(e.target.value); }} className="input mt-1 text-[12.5px]" placeholder="link please" />
                </label>
                <button onClick={() => runSim.mutate()} disabled={runSim.isPending} className="btn btn-sm mt-2 w-full">
                  <Play size={12} /> {runSim.isPending ? 'Simulating…' : 'Simulate'}
                </button>
                <p className="mt-1.5 text-[11.5px] text-muted leading-relaxed">Runs your saved rules, sends nothing. Save first to test what you just changed.</p>

                <AnimatePresence initial={false}>
                  {sim && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                      <div className="mt-2.5 space-y-2 text-[12px]">
                        {sim.matched ? (
                          <div className="rounded-lg border border-accent/40 bg-accent-soft/60 p-2 text-ink-2">
                            <CheckCircle2 size={12} className="mr-1 -mt-0.5 inline text-accent" />
                            <b>{sim.matched.name}</b> would answer
                            {sim.wouldSend?.dm ? <div className="mt-1 whitespace-pre-wrap break-words text-muted">DM: {sim.wouldSend.dm}</div> : null}
                            {sim.wouldSend?.publicReply ? <div className="mt-0.5 whitespace-pre-wrap break-words text-muted">Comment: {sim.wouldSend.publicReply}</div> : null}
                          </div>
                        ) : (
                          <div className="rounded-lg border border-line bg-surface-2 p-2 text-ink-2">No rule would answer that.</div>
                        )}
                        {sim.skipped.length ? (
                          <ul className="space-y-1 text-muted">
                            {sim.skipped.slice(0, 6).map((s) => <li key={s.ruleId}><span className="text-ink-2">{s.name}</span> — {s.reason}</li>)}
                          </ul>
                        ) : null}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="mt-3 border-t border-line pt-3">
                  <span className="text-[11.5px] font-medium text-ink-2">Send a real test</span>
                  {/* Everything above works without Instagram; only a real send needs a live connection. */}
                  {sendBlockedReason ? (
                    <p className="mt-1 text-[11.5px] text-muted leading-relaxed">{sendBlockedReason}</p>
                  ) : d.id ? (
                    <>
                      <input value={recipient} onChange={(e) => setRecipient(e.target.value)} className="input mt-1 font-mono text-[12px]" placeholder="IG-scoped sender id" />
                      <button onClick={() => testSend.mutate()} disabled={!recipient.trim() || testSend.isPending} className="btn btn-sm mt-2 w-full">
                        <Send size={12} /> {testSend.isPending ? 'Sending…' : 'Send to this person'}
                      </button>
                      <p className="mt-1.5 text-[11.5px] text-muted leading-relaxed">Instagram only lets an app DM someone within 24 hours of their last message to you. Paste a sender id from the activity log.</p>
                      {sendResult && (
                        <div className={cn('mt-2 rounded-lg border p-2 text-[12px] break-words', sendResult.ok ? 'border-accent/40 bg-accent-soft/60 text-ink-2' : 'border-danger/40 bg-danger-soft/50 text-danger')}>
                          {sendResult.ok ? 'Instagram accepted the message.' : <>Instagram said: {sendResult.error}</>}
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="mt-1 text-[11.5px] text-muted leading-relaxed">Save the rule first — a real test send needs a saved rule to log the attempt against.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* footer */}
        <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1 text-[12px] text-muted">
            {problem ? <span className="inline-flex items-center gap-1.5 text-warn"><TriangleAlert size={12} /> {problem}</span> : <span className="inline-flex items-center gap-1.5"><FlaskConical size={12} /> {triggerSentence(d.trigger, d.keywords, d.mediaIds.length)}</span>}
          </div>
          <button onClick={requestClose} className="btn">{dirty ? 'Cancel' : 'Close'}</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !!problem || (!dirty && !!d.id)} className="btn btn-primary">
            <Save size={13} /> {save.isPending ? 'Saving…' : d.id ? 'Save changes' : 'Create rule'}
          </button>
        </div>

        {/* unsaved-changes guard */}
        <AnimatePresence>
          {confirmClose && (
            <motion.div className="absolute inset-0 z-10 grid place-items-center bg-ink/30 backdrop-blur-[2px] sm:rounded-2xl" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="mx-4 max-w-sm rounded-2xl border border-line bg-surface p-5" style={{ boxShadow: 'var(--shadow-lg)' }}>
                <h4 className="display text-[20px]">Leave without saving?</h4>
                <p className="mt-1.5 text-[13px] text-ink-2 leading-relaxed">This rule has changes that were never sent to the server. Closing now throws them away.</p>
                <div className="mt-4 flex justify-end gap-2">
                  <button onClick={() => setConfirmClose(false)} className="btn">Keep editing</button>
                  <button onClick={() => { setConfirmClose(false); onClose(); }} className="btn btn-danger">Discard changes</button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(<AnimatePresence>{sheet}</AnimatePresence>, document.body);
}
