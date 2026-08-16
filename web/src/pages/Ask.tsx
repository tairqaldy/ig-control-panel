import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { Plus, PanelLeftOpen, History, ArrowDown, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import type { Stats } from '../lib/types';
import type { AskIntent, AskMessage, AskMode, AskSuggestion, Conversation } from '../lib/types-ask';
import { deleteConversation, getConversation, getSuggestions, isMissingEndpoint, listConversations, MODE_INTENT, streamAsk, updateConversation } from '../lib/ask';
import { useItemModal, useAuth, useQuota } from '../lib/store';
import { fmtLimit, isUnlimited, meterFull, planName } from '../lib/plans';
import { cn } from '../lib/utils';
import { ConversationRail } from '../components/ask/ConversationRail';
import { Composer, type ComposerHandle } from '../components/ask/Composer';
import { AssistantMessage, UserBubble, type MessageActions } from '../components/ask/Messages';
import { EmptyState } from '../components/ask/EmptyState';

const DRAFT_KEY = 'rs-ask-draft-v2';   // unsaved (no server conversation yet) messages survive a reload in this tab
const RAIL_KEY = 'rs-ask-rail';
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const now = () => Math.floor(Date.now() / 1000);

/** Questions about the product itself are answered locally (free, instant) — doubles as onboarding. */
const GUIDE = `**Resurfly turns your Instagram saves into a searchable second brain.** The short tour:

- **Library** — every save with a title, one-liner, summary, key points, tags, category, hook analysis and transcript. Filter by category/tag/creator/format, search by keyword *and* meaning, favorite, add notes. Export to JSON/CSV/Markdown/Obsidian.
- **Ask** (here) — ask in plain language; answers come only from your saves and cite them as clickable chips. Use the mode chips for a **content brief**, your **taste** in numbers, or your **Instagram analytics**.
- **Resurface** — three saves worth a second look every day.
- **Graph** — a map of your taste: saves ↔ tags ↔ creators ↔ categories.
- **Import** — the Companion extension or the one-time script brings your saves in; the Analysis plan controls what gets analyzed.
- **Automations** — comment→DM and keyword auto-replies for your own account on Meta's official API.

Try next:
- What are the recurring themes across everything I saved?
- Which tools did I save the most, and what were they for?
- Content brief: a reel from my most-saved productivity advice`;

function localAnswer(q: string): string | null {
  const s = q.trim().toLowerCase();
  if (/^(hi|hello|hey|yo|help|start|guide|tour)\b/.test(s) || /(what (can|do) (you|u|this|resurfly|the app|this app|this platform)|how (does|do) (this|resurfly|it) work|what is (this|resurfly)|what('s| is) this (for|about)|how to use|onboard)/.test(s)) return GUIDE;
  return null;
}

/** Fill the viewport below the page header (works with the hosted plan banner and the mobile top bar without magic numbers). */
function useFillHeight(ref: React.RefObject<HTMLElement | null>) {
  const [h, setH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const measure = () => { const top = el.getBoundingClientRect().top + window.scrollY; const pad = window.innerWidth >= 1024 ? 32 : 24; setH(Math.max(420, window.innerHeight - top - pad)); };
    measure();
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro && el.parentElement) ro.observe(el.parentElement);
    return () => { window.removeEventListener('resize', measure); ro?.disconnect(); };
  }, [ref]);
  return h;
}

export default function Ask() {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const modal = useItemModal();
  const auth = useAuth();
  const { plan, openUpgrade, refreshPlan } = useQuota();
  const openaiOff = auth.setupIssues.some((s) => s.includes('OPENAI'));

  /* ---------------- conversation state ---------------- */
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<AskMessage[]>(() => { try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || '[]'); } catch { return []; } });
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<AskMode>('library');
  const [railOpen, setRailOpen] = useState<boolean>(() => localStorage.getItem(RAIL_KEY) !== '0');
  const [sheetOpen, setSheetOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const hydratedRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const height = useFillHeight(rootRef);
  // Live mirrors so `send` (called from effects/timeouts) never reads a stale conversation id / message list.
  const activeIdRef = useRef<number | null>(null);
  const messagesRef = useRef<AskMessage[]>(messages);
  const busyRef = useRef(false);
  activeIdRef.current = activeId; messagesRef.current = messages; busyRef.current = busy;

  useEffect(() => { localStorage.setItem(RAIL_KEY, railOpen ? '1' : '0'); }, [railOpen]);
  // Unsaved conversation → keep it in this tab; once the server owns it, drop the draft.
  useEffect(() => {
    if (activeId) { sessionStorage.removeItem(DRAFT_KEY); return; }
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(messages.map((m) => ({ ...m, streaming: false })))); } catch {}
  }, [messages, activeId]);
  useEffect(() => () => abortRef.current?.abort(), []);

  /* ---------------- data ---------------- */
  const convs = useQuery({ queryKey: ['ask-conversations'], queryFn: listConversations, retry: false, staleTime: 15_000 });
  const supported = !(convs.error && isMissingEndpoint(convs.error));
  const detail = useQuery({ queryKey: ['ask-conversation', activeId], queryFn: () => getConversation(activeId!), enabled: !!activeId && supported && hydratedRef.current !== activeId, retry: false });
  const suggestions = useQuery({ queryKey: ['ask-suggestions'], queryFn: getSuggestions, retry: false, staleTime: 5 * 60_000 });
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => api.get<Stats>('/api/stats'), staleTime: 60_000 });
  const total = stats.data?.totals.total ?? null;

  // Hydrate messages from the server when a conversation from the rail is opened.
  useEffect(() => {
    if (!activeId || !detail.data || hydratedRef.current === activeId || busy) return;
    const list: AskMessage[] = [];
    let lastQ: string | undefined;
    for (const m of detail.data.messages) {
      if (m.role === 'user') lastQ = m.content;
      list.push({ localId: `s${m.id}`, serverId: m.id, role: m.role, content: m.content, sources: m.sources, intent: m.intent, createdAt: m.createdAt, question: m.role === 'assistant' ? lastQ : undefined });
    }
    setMessages(list);
    hydratedRef.current = activeId;
  }, [activeId, detail.data, busy]);
  useEffect(() => {
    if (detail.error && activeId && !isMissingEndpoint(detail.error)) toast.error('Could not load that conversation.');
    if (detail.error && activeId && isMissingEndpoint(detail.error)) { setActiveId(null); toast.error('That conversation no longer exists.'); qc.invalidateQueries({ queryKey: ['ask-conversations'] }); }
  }, [detail.error, activeId, qc]);

  const conversations = convs.data ?? [];
  const activeConv = useMemo(() => conversations.find((c) => c.id === activeId) ?? null, [conversations, activeId]);
  const [pendingTitle, setPendingTitle] = useState<string | null>(null);
  const title = activeConv?.title || pendingTitle || (messages.find((m) => m.role === 'user')?.content ?? '').slice(0, 60);

  /* ---------------- quota (hosted) ---------------- */
  const askMeter = plan && plan.plan !== 'owner' ? plan.usage?.ask : undefined;
  const askBlocked = !!plan && plan.plan !== 'owner' && (plan.effectivePlan === 'free' || meterFull(askMeter));

  /* ---------------- scrolling ---------------- */
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const onScroll = () => { const el = scrollRef.current; if (!el) return; const gap = el.scrollHeight - el.scrollTop - el.clientHeight; atBottomRef.current = gap < 56; setShowJump(gap > 240); };
  const scrollToBottom = useCallback((smooth = true) => { const el = scrollRef.current; if (!el) return; el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); atBottomRef.current = true; setShowJump(false); }, []);
  const lastLen = messages.length ? messages[messages.length - 1].content.length : 0;
  useEffect(() => { if (atBottomRef.current) scrollToBottom(false); }, [lastLen, messages.length, scrollToBottom]);

  /* ---------------- helpers ---------------- */
  const patch = useCallback((localId: string, fn: (m: AskMessage) => AskMessage) => setMessages((ms) => ms.map((m) => (m.localId === localId ? fn(m) : m))), []);
  const stop = useCallback(() => abortRef.current?.abort(), []);
  /** Forget the current thread (local state + refs) without touching the server. */
  const resetThread = useCallback((id: number | null) => {
    abortRef.current?.abort();
    activeIdRef.current = id; hydratedRef.current = null; messagesRef.current = [];
    setActiveId(id); setMessages([]); setPendingTitle(null); setSheetOpen(false);
  }, []);
  const newConversation = useCallback(() => {
    resetThread(null); setInput('');
    window.setTimeout(() => composerRef.current?.focus(), 30);
  }, [resetThread]);
  const selectConversation = useCallback((id: number) => {
    if (id === activeIdRef.current) { setSheetOpen(false); return; }
    qc.removeQueries({ queryKey: ['ask-conversation', id] }); // no stale cache: hydrate from a fresh fetch
    resetThread(id);
  }, [qc, resetThread]);

  /**
   * Send a question. `intent` forces a strategy (undefined = the composer's mode chip, null = let the server route);
   * `appendUser=false` re-uses the existing user bubble (Regenerate); `excludeLocalId` drops a message from the thread + history.
   */
  const send = useCallback(async (raw: string, opts: { intent?: AskIntent | null; appendUser?: boolean; excludeLocalId?: string; retried?: boolean } = {}) => {
    const question = raw.trim();
    const intent = opts.intent === undefined ? MODE_INTENT[mode] : opts.intent;
    if (!question || busyRef.current) return;
    const activeId = activeIdRef.current;
    const messages = messagesRef.current.filter((m) => m.localId !== opts.excludeLocalId);
    setInput('');
    const local = localAnswer(question);
    if (local) {
      setMessages((ms) => [...ms, { localId: uid(), role: 'user', content: question, sources: [], intent: null, createdAt: now(), local: true }, { localId: uid(), role: 'assistant', content: local, sources: [], intent: 'guide', createdAt: now(), local: true }]);
      window.setTimeout(() => scrollToBottom(true), 20);
      return;
    }
    if (askBlocked) { openUpgrade({ quota: { error: 'Question allowance used', code: 'quota', metric: 'ask', used: askMeter?.used ?? 0, limit: askMeter?.limit ?? 0, plan: plan!.effectivePlan, upgrade: true } }); return; }
    if (openaiOff) { toast.error('OpenAI isn’t configured — add your key in Settings first.'); return; }

    const history = messages.filter((m) => !m.error && !m.local && !m.streaming && m.content).slice(-8).map((m) => ({ role: m.role, content: m.content }));
    const userMsg: AskMessage = { localId: uid(), role: 'user', content: question, sources: [], intent: null, createdAt: now() };
    const asst: AskMessage = { localId: uid(), role: 'assistant', content: '', sources: [], intent: intent ?? null, createdAt: now(), streaming: true, question };
    setMessages((ms) => [...ms.filter((m) => m.localId !== opts.excludeLocalId), ...(opts.appendUser === false ? [] : [userMsg]), asst]);
    setBusy(true); busyRef.current = true;
    atBottomRef.current = true;
    window.setTimeout(() => scrollToBottom(true), 20);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const convBefore = activeId;

    const res = await streamAsk({ question, conversationId: activeId, history, intent }, {
      signal: ctrl.signal,
      onMeta: (meta) => {
        if (meta.intent) patch(asst.localId, (m) => ({ ...m, intent: meta.intent }));
        if (meta.conversationId && meta.conversationId !== convBefore) {
          hydratedRef.current = meta.conversationId; // we already hold the messages; don't re-hydrate over the stream
          activeIdRef.current = meta.conversationId;
          setActiveId(meta.conversationId);
        }
        if (meta.title) setPendingTitle(meta.title);
        if (meta.conversationId) {
          const id = meta.conversationId; const t = meta.title || question.slice(0, 60);
          qc.setQueryData<Conversation[]>(['ask-conversations'], (old) => {
            const rest = (old ?? []).filter((c) => c.id !== id);
            const prev = (old ?? []).find((c) => c.id === id);
            return [{ id, title: t, updatedAt: now(), pinned: prev?.pinned ?? false, messageCount: (prev?.messageCount ?? 0) + 2 }, ...rest];
          });
        }
      },
      onSources: (sources) => patch(asst.localId, (m) => ({ ...m, sources })),
      onDelta: (t) => patch(asst.localId, (m) => ({ ...m, content: m.content + t })),
      onError: (msg) => patch(asst.localId, (m) => ({ ...m, error: msg, streaming: false })),
    });

    setBusy(false); busyRef.current = false;
    abortRef.current = null;
    if (res.done?.title) setPendingTitle(res.done.title);
    if (res.done?.intent) patch(asst.localId, (m) => ({ ...m, intent: res.done!.intent }));
    patch(asst.localId, (m) => ({ ...m, streaming: false, ...(res.aborted && !m.content && !m.error ? { error: 'Stopped before the answer started.' } : {}) }));
    if (res.error && !res.aborted) {
      // The conversation was deleted elsewhere (server 404): start a fresh one with the same question, once.
      if (/conversation not found/i.test(res.error) && activeId && !opts.retried) {
        resetThread(null); qc.invalidateQueries({ queryKey: ['ask-conversations'] });
        window.setTimeout(() => void send(question, { ...opts, appendUser: true, retried: true }), 0);
        return;
      }
      // 402 already opened the upgrade modal (api.ts); everything else gets a toast.
      if (!/allowance|quota|upgrade/i.test(res.error)) toast.error(res.error);
    }
    if (askMeter) void refreshPlan();
    if (supported && (res.meta.conversationId || res.done?.conversationId)) {
      qc.invalidateQueries({ queryKey: ['ask-conversations'] });
      window.setTimeout(() => qc.invalidateQueries({ queryKey: ['ask-conversations'] }), 6000); // the improved title lands after the first answer
    }
  }, [mode, askBlocked, askMeter, plan, openUpgrade, openaiOff, patch, qc, refreshPlan, scrollToBottom, supported, resetThread]);

  /* ---------------- deep links (?q= from AskHero / palette / modal · ?c=<id> · ?mode=) ---------------- */
  const pendingQ = sp.get('q');
  const pendingC = sp.get('c');
  const pendingMode = sp.get('mode');
  useEffect(() => {
    if (!pendingQ && !pendingC && !pendingMode) return;
    setSp({}, { replace: true });
    if (pendingMode && (['library', 'create', 'stats', 'analytics'] as string[]).includes(pendingMode)) setMode(pendingMode as AskMode);
    if (pendingC && Number(pendingC)) selectConversation(Number(pendingC));
    if (pendingQ) {
      // A fresh question from another page starts a fresh conversation (unless one was just opened via ?c=).
      if (!pendingC) resetThread(null);
      window.setTimeout(() => void send(pendingQ, { intent: null }), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingQ, pendingC, pendingMode]);

  /* ---------------- keyboard: "/" focuses the composer, Esc stops / closes the sheet ---------------- */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); composerRef.current?.focus(); }
      else if (e.key === 'Escape') { if (abortRef.current) { e.preventDefault(); stop(); } else if (sheetOpen) setSheetOpen(false); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [stop, sheetOpen]);

  /* ---------------- rail actions ---------------- */
  const pin = async (c: Conversation) => {
    qc.setQueryData<Conversation[]>(['ask-conversations'], (old) => (old ?? []).map((x) => (x.id === c.id ? { ...x, pinned: !c.pinned } : x)));
    try { await updateConversation(c.id, { pinned: !c.pinned }); } catch { toast.error('Could not update the pin.'); }
    qc.invalidateQueries({ queryKey: ['ask-conversations'] });
  };
  const rename = async (c: Conversation, t: string) => {
    qc.setQueryData<Conversation[]>(['ask-conversations'], (old) => (old ?? []).map((x) => (x.id === c.id ? { ...x, title: t } : x)));
    try { await updateConversation(c.id, { title: t }); } catch { toast.error('Could not rename.'); }
    qc.invalidateQueries({ queryKey: ['ask-conversations'] });
  };
  const remove = async (c: Conversation) => {
    if (!window.confirm(`Delete “${c.title}”? This cannot be undone.`)) return;
    qc.setQueryData<Conversation[]>(['ask-conversations'], (old) => (old ?? []).filter((x) => x.id !== c.id));
    if (c.id === activeId) newConversation();
    try { await deleteConversation(c.id); toast('Conversation deleted'); } catch { toast.error('Could not delete.'); }
    qc.invalidateQueries({ queryKey: ['ask-conversations'] });
  };
  const clearLocal = () => { newConversation(); sessionStorage.removeItem(DRAFT_KEY); };

  /* ---------------- message actions ---------------- */
  const actions: MessageActions = useMemo(() => ({
    openItem: (id) => modal.open(id),
    regenerate: (m) => { if (!m.question || busy) return; void send(m.question, { intent: m.intent && m.intent !== 'guide' ? m.intent : null, appendUser: false, excludeLocalId: m.localId }); },
    toBrief: (m) => { void send(`Turn the answer above${m.question ? ` (about “${m.question.slice(0, 80)}”)` : ''} into a content brief I can shoot this week — hook options, outline, CTA, format, and why it fits my taste. Cite the saves.`, { intent: 'create' }); },
    showInLibrary: (m) => { nav(`/library?q=${encodeURIComponent((m.question || '').slice(0, 120))}`); },
    followUp: (q) => { void send(q, { intent: null }); },
  }), [modal, busy, send, nav]);

  const lastQuestion = useMemo(() => [...messages].reverse().find((m) => m.role === 'user' && !m.local)?.content ?? null, [messages]);
  const hasMessages = messages.length > 0;
  const pickSuggestion = (s: AskSuggestion) => void send(s.text, { intent: s.intent && s.intent !== 'guide' && s.intent !== 'chat' && s.intent !== 'library' ? s.intent : null });

  const meter = askMeter ? (
    <button type="button" onClick={() => openUpgrade()} className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors', askBlocked ? 'border-warn/50 bg-warn-soft text-warn' : 'border-line bg-surface text-muted hover:border-line-2 hover:text-ink')} title="Questions this month on your plan">
      <span className={cn('h-1.5 w-1.5 rounded-full', askBlocked ? 'bg-warn' : 'bg-accent')} />
      {plan?.effectivePlan === 'free' ? `${planName(plan.plan)} · Ask is paused` : <>{askMeter.used.toLocaleString()} / {fmtLimit(askMeter.limit)} questions this month{!isUnlimited(askMeter.limit) && ` · ${planName(plan?.effectivePlan)}`}</>}
      {askBlocked && <span className="font-medium">· Upgrade</span>}
    </button>
  ) : null;

  const railProps = { conversations, loading: convs.isLoading, supported, activeId, onSelect: selectConversation, onNew: newConversation, onPin: pin, onDelete: remove, onRename: rename };

  return (
    <div ref={rootRef} className="flex flex-col" style={{ height: height ?? undefined, minHeight: 420 }}>
      {/* Header */}
      <div className="mb-3 flex items-center gap-2 rise">
        {!railOpen && <button type="button" onClick={() => setRailOpen(true)} className="btn btn-ghost btn-sm !px-1.5 hidden lg:inline-flex text-muted" title="Show conversations" aria-label="Show conversations"><PanelLeftOpen size={15} /></button>}
        <button type="button" onClick={() => setSheetOpen(true)} className="btn btn-sm lg:hidden"><History size={13} /> History</button>
        <div className="min-w-0 flex-1">
          {hasMessages ? (
            <>
              <div className="eyebrow">Ask{activeConv?.pinned ? ' · pinned' : ''}</div>
              <div className="display truncate text-[20px] leading-tight">{title || 'New conversation'}</div>
            </>
          ) : (
            <div className="eyebrow truncate">Ask<span className="hidden sm:inline"> · your saves, answered with citations</span></div>
          )}
        </div>
        {hasMessages && !supported && <button type="button" onClick={clearLocal} className="btn btn-sm"><Trash2 size={13} /> Clear</button>}
        {(hasMessages || activeId) && <button type="button" onClick={newConversation} className="btn btn-sm" title="Start a new conversation" aria-label="New conversation"><Plus size={13} /> <span className="hidden sm:inline">New</span></button>}
      </div>
      {openaiOff && <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-warn/40 bg-warn-soft px-3 py-2 text-[12.5px]"><span>Ask needs an OpenAI key — nothing is sent until one is set.</span><Link to="/settings" className="btn btn-sm ml-auto">Add key in Settings</Link></div>}

      <div className="flex min-h-0 flex-1 gap-4">
        {/* Desktop rail */}
        <AnimatePresence initial={false}>
          {railOpen && (
            <motion.aside key="rail" initial={{ width: 0, opacity: 0 }} animate={{ width: 264, opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.2, 0.7, 0.2, 1] }} className="hidden shrink-0 overflow-hidden lg:block">
              <div className="h-full w-[264px] pr-1">
                <ConversationRail {...railProps} onCollapse={() => setRailOpen(false)} />
              </div>
            </motion.aside>
          )}
        </AnimatePresence>

        {/* Thread */}
        <section className="relative flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-0.5 pb-4">
            {!hasMessages ? (
              detail.isLoading && activeId ? (
                <div className="mx-auto max-w-3xl space-y-4 pt-4">{[0, 1, 2].map((i) => <div key={i} className={cn('skeleton h-16 rounded-2xl', i % 2 === 0 ? 'ml-auto w-1/2' : 'w-full')} />)}</div>
              ) : (
                <EmptyState suggestions={suggestions.data ?? []} loading={suggestions.isLoading} onPick={pickSuggestion} username={stats.data?.igUsername || (auth.username && !auth.username.includes('@') ? auth.username : null)} total={total} hasLibrary={total === null || total > 0} />
              )
            ) : (
              <div className="mx-auto max-w-3xl space-y-5 pt-1">
                {messages.map((m, i) => m.role === 'user'
                  ? <UserBubble key={m.localId} m={m} />
                  : <AssistantMessage key={m.localId} m={m} actions={actions} isLast={i === messages.length - 1} busy={busy} />)}
              </div>
            )}
          </div>
          <AnimatePresence>
            {showJump && hasMessages && (
              <motion.button key="jump" type="button" onClick={() => scrollToBottom(true)} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} className="btn btn-sm absolute bottom-[132px] left-1/2 z-10 -translate-x-1/2 !rounded-full shadow-lg" style={{ boxShadow: 'var(--shadow-lg)' }}><ArrowDown size={12} /> {busy ? 'Follow the answer' : 'Jump to latest'}</motion.button>
            )}
          </AnimatePresence>
          <div className="pt-2">
            <Composer ref={composerRef} value={input} onChange={setInput} onSend={() => void send(input)} onStop={stop} busy={busy} disabled={openaiOff} mode={mode} onMode={setMode} lastQuestion={lastQuestion} meter={meter} compact={!hasMessages} />
          </div>
        </section>
      </div>

      {/* Mobile sheet with the rail */}
      <AnimatePresence>
        {sheetOpen && (
          <motion.div key="sheet" className="fixed inset-0 z-[70] lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute inset-0 bg-ink/40 backdrop-blur-[2px]" onClick={() => setSheetOpen(false)} />
            <motion.div initial={{ x: -24, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -24, opacity: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 34 }} className="absolute inset-y-0 left-0 flex w-[min(86vw,340px)] flex-col border-r border-line bg-bg p-3" style={{ boxShadow: 'var(--shadow-lg)' }} role="dialog" aria-label="Conversations">
              <ConversationRail {...railProps} onClose={() => setSheetOpen(false)} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
