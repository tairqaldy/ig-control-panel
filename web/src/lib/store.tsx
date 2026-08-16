import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { PlanId, PlanInfo, QuotaError } from './types';
import { meterFull } from './plans';

/* ---------------- Auth ---------------- */
interface MeResponse {
  authenticated: boolean; username: string | null; setupIssues: string[]; loginEnabled: boolean;
  // hosted-mode extras (HOSTED-SPEC §3); absent on the single-tenant server
  hosted?: boolean; signupsEnabled?: boolean; plan?: PlanInfo | null; email?: string | null; tenantId?: number | null;
}
interface AuthState { authenticated: boolean; username: string | null; setupIssues: string[]; loginEnabled: boolean; loading: boolean; hosted: boolean; signupsEnabled: boolean; plan: PlanInfo | null; email: string | null; tenantId: number | null }
interface AuthCtx extends AuthState { login: (u: string, p: string) => Promise<void>; signup: (email: string, password: string, name?: string) => Promise<void>; logout: () => Promise<void>; refresh: () => void }
const AuthContext = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['auth'], queryFn: () => api.get<MeResponse>('/api/auth/me'), staleTime: 60_000 });
  useEffect(() => {
    const h = () => qc.setQueryData(['auth'], (old: any) => (old ? { ...old, authenticated: false } : old));
    window.addEventListener('rs:unauthorized', h);
    return () => window.removeEventListener('rs:unauthorized', h);
  }, [qc]);
  const login = useCallback(async (u: string, p: string) => {
    // Single-tenant server reads username/passcode; the hosted server accepts username|email + passcode|password. Send both spellings.
    await api.post('/api/auth/login', { username: u, passcode: p, email: u, password: p });
    await qc.invalidateQueries({ queryKey: ['auth'] });
  }, [qc]);
  const signup = useCallback(async (email: string, password: string, name?: string) => {
    await api.post('/api/auth/signup', { email, password, ...(name ? { name } : {}) });
    await qc.invalidateQueries({ queryKey: ['auth'] });
  }, [qc]);
  const logout = useCallback(async () => {
    try { await api.post('/api/auth/logout'); } finally {
      try { sessionStorage.clear(); } catch {}
      qc.clear();
      window.location.assign('/'); // hard reload: guarantees no cached data survives the session
    }
  }, [qc]);
  const value = useMemo<AuthCtx>(() => ({
    authenticated: !!q.data?.authenticated, username: q.data?.username ?? null, setupIssues: q.data?.setupIssues ?? [], loginEnabled: q.data?.loginEnabled ?? true,
    hosted: !!q.data?.hosted, signupsEnabled: q.data?.signupsEnabled ?? !!q.data?.hosted, plan: q.data?.plan ?? null, email: q.data?.email ?? null, tenantId: q.data?.tenantId ?? null,
    loading: q.isLoading, login, signup, logout, refresh: () => qc.invalidateQueries({ queryKey: ['auth'] }),
  }), [q.data, q.isLoading, login, signup, logout, qc]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export const useAuth = () => { const c = useContext(AuthContext); if (!c) throw new Error('AuthProvider missing'); return c; };

/* ---------------- Plan + quota / upgrade modal (hosted only) ----------------
   One subscription to GET /api/plan for the whole app, plus the state of the global UpgradeModal.
   Anything that gets an HTTP 402 with { code: 'quota' } (see api.ts) opens the modal with a contextual message. */
export interface UpgradeIntent { quota?: QuotaError | null; preselect?: Exclude<PlanId, 'owner' | 'trial' | 'free'>; interval?: 'month' | 'year'; reason?: string }
interface QuotaCtx {
  plan: PlanInfo | null; planLoading: boolean; refreshPlan: () => Promise<unknown>;
  open: boolean; intent: UpgradeIntent | null; openUpgrade: (intent?: UpgradeIntent) => void; close: () => void;
  /** hosted && the tenant can't analyze more saves right now (allowance used up or browse-only Free) */
  analyzeExhausted: boolean;
}
const QuotaContext = createContext<QuotaCtx | null>(null);
export function QuotaProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const qc = useQueryClient();
  const enabled = auth.hosted && auth.authenticated;
  const q = useQuery({ queryKey: ['plan'], queryFn: () => api.get<PlanInfo>('/api/plan'), enabled, staleTime: 15_000, refetchInterval: 60_000 });
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<UpgradeIntent | null>(null);
  const openUpgrade = useCallback((i?: UpgradeIntent) => { setIntent(i ?? null); setOpen(true); }, []);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!enabled) return;
    const h = (e: Event) => { const d = (e as CustomEvent<QuotaError>).detail; openUpgrade({ quota: d }); qc.invalidateQueries({ queryKey: ['plan'] }); };
    window.addEventListener('rs:quota', h);
    return () => window.removeEventListener('rs:quota', h);
  }, [enabled, openUpgrade, qc]);
  const plan = (enabled ? q.data ?? auth.plan : null) ?? null;
  const analyzeExhausted = !!(enabled && plan && (plan.effectivePlan === 'free' || meterFull(plan.usage?.analyze) || meterFull(plan.usage?.analyzeMonth)));
  const value = useMemo<QuotaCtx>(() => ({ plan, planLoading: enabled && q.isLoading, refreshPlan: () => qc.invalidateQueries({ queryKey: ['plan'] }), open, intent, openUpgrade, close, analyzeExhausted }), [plan, enabled, q.isLoading, qc, open, intent, openUpgrade, close, analyzeExhausted]);
  return <QuotaContext.Provider value={value}>{children}</QuotaContext.Provider>;
}
const NO_QUOTA: QuotaCtx = { plan: null, planLoading: false, refreshPlan: async () => {}, open: false, intent: null, openUpgrade: () => {}, close: () => {}, analyzeExhausted: false };
/** Safe outside the provider (returns inert defaults) so leaf components like ItemCard can call it anywhere. */
export const useQuota = () => useContext(QuotaContext) ?? NO_QUOTA;
export const usePlan = () => useQuota().plan;

/* ---------------- Theme ---------------- */
type Theme = 'light' | 'dark';
const ThemeContext = createContext<{ theme: Theme; toggle: () => void; set: (t: Theme) => void } | null>(null);
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'));
  const set = useCallback((t: Theme) => {
    setTheme(t);
    document.documentElement.classList.toggle('dark', t === 'dark');
    try { localStorage.setItem('rs-theme', t); } catch {}
  }, []);
  const toggle = useCallback(() => set(theme === 'dark' ? 'light' : 'dark'), [theme, set]);
  return <ThemeContext.Provider value={{ theme, toggle, set }}>{children}</ThemeContext.Provider>;
}
export const useTheme = () => { const c = useContext(ThemeContext); if (!c) throw new Error('ThemeProvider missing'); return c; };

/* ---------------- Item modal (global) ---------------- */
interface ModalCtx { openId: string | null; open: (id: string) => void; close: () => void; history: string[]; back: () => void }
const ModalContext = createContext<ModalCtx | null>(null);
export function ItemModalProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<string[]>([]);
  const open = useCallback((id: string) => setStack((s) => (s[s.length - 1] === id ? s : [...s, id])), []);
  const close = useCallback(() => setStack([]), []);
  const back = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  const value = useMemo(() => ({ openId: stack[stack.length - 1] ?? null, open, close, history: stack, back }), [stack, open, close, back]);
  return <ModalContext.Provider value={value}>{children}</ModalContext.Provider>;
}
export const useItemModal = () => { const c = useContext(ModalContext); if (!c) throw new Error('ItemModalProvider missing'); return c; };

/* ---------------- Command palette ---------------- */
const PaletteContext = createContext<{ open: boolean; setOpen: (v: boolean) => void } | null>(null);
export function PaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  return <PaletteContext.Provider value={{ open, setOpen }}>{children}</PaletteContext.Provider>;
}
export const usePalette = () => { const c = useContext(PaletteContext); if (!c) throw new Error('PaletteProvider missing'); return c; };
