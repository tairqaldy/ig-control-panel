import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

/* ---------------- Auth ---------------- */
interface AuthState { authenticated: boolean; username: string | null; setupIssues: string[]; loginEnabled: boolean; loading: boolean }
interface AuthCtx extends AuthState { login: (u: string, p: string) => Promise<void>; logout: () => Promise<void>; refresh: () => void }
const AuthContext = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['auth'], queryFn: () => api.get<Omit<AuthState, 'loading'>>('/api/auth/me'), staleTime: 60_000 });
  useEffect(() => {
    const h = () => qc.setQueryData(['auth'], (old: any) => (old ? { ...old, authenticated: false } : old));
    window.addEventListener('rs:unauthorized', h);
    return () => window.removeEventListener('rs:unauthorized', h);
  }, [qc]);
  const login = useCallback(async (u: string, p: string) => {
    await api.post('/api/auth/login', { username: u, passcode: p });
    await qc.invalidateQueries({ queryKey: ['auth'] });
  }, [qc]);
  const logout = useCallback(async () => {
    await api.post('/api/auth/logout');
    qc.clear();
    await qc.invalidateQueries({ queryKey: ['auth'] });
  }, [qc]);
  const value = useMemo<AuthCtx>(() => ({
    authenticated: !!q.data?.authenticated, username: q.data?.username ?? null, setupIssues: q.data?.setupIssues ?? [], loginEnabled: q.data?.loginEnabled ?? true,
    loading: q.isLoading, login, logout, refresh: () => qc.invalidateQueries({ queryKey: ['auth'] }),
  }), [q.data, q.isLoading, login, logout, qc]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export const useAuth = () => { const c = useContext(AuthContext); if (!c) throw new Error('AuthProvider missing'); return c; };

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
