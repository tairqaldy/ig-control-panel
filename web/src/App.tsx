import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { AuthProvider, ItemModalProvider, PaletteProvider, QuotaProvider, ThemeProvider, useAuth } from './lib/store';
import { Shell } from './components/Shell';
import { ItemModal } from './components/ItemModal';
import { CommandPalette } from './components/CommandPalette';
import { UpgradeModal } from './components/UpgradeModal';
import { Skeleton } from './components/ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Library from './pages/Library';
import Ask from './pages/Ask';
import Import from './pages/Import';
import Automations from './pages/Automations';
import Settings from './pages/Settings';
import Resurface from './pages/Resurface';
const Graph = lazy(() => import('./pages/Graph'));
const Analytics = lazy(() => import('./pages/Analytics')); // Instagram analytics (ROUND5 §3)
// Hosted-only pages, lazy so the single-tenant bundle doesn't pay for them.
const Landing = lazy(() => import('./pages/Landing'));
const Pricing = lazy(() => import('./pages/Pricing'));
const Signup = lazy(() => import('./pages/Signup'));
const Billing = lazy(() => import('./pages/Billing'));
const Welcome = lazy(() => import('./pages/Welcome')); // guided first run (ROUND5 §7); Dashboard redirects '/' → '/welcome' on hosted first run
const Legal = lazy(() => import('./pages/Legal')); // /privacy, /terms, /refunds (ROUND5 §8b) — public, rendered outside the app shell whatever the auth state

function Loading() {
  return (
    <div className="h-full min-h-[50vh] grid place-items-center">
      <div className="flex items-center gap-3 text-muted text-sm"><span className="h-2 w-2 rounded-full bg-accent pulse-dot" /> Loading…</div>
    </div>
  );
}

function Gate() {
  const auth = useAuth();
  const loc = useLocation();
  if (auth.loading) return <Loading />;
  if (/^\/(privacy(\/extension)?|security|terms|refunds)\/?$/.test(loc.pathname)) return <Suspense fallback={<Loading />}><Legal /></Suspense>;
  if (!auth.authenticated) {
    // Single-tenant: the login form everywhere (unchanged). Hosted: public marketing routes + login/signup.
    if (!auth.hosted) return <Login />;
    return (
      <Suspense fallback={<Loading />}>
        <Routes location={loc}>
          <Route path="/" element={<Landing />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="*" element={<Navigate to="/login" replace state={{ from: loc.pathname }} />} />
        </Routes>
      </Suspense>
    );
  }
  return (
    <ItemModalProvider>
      <PaletteProvider>
        <Shell>
          <Routes location={loc}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/library" element={<Library />} />
            <Route path="/resurface" element={<Resurface />} />
            <Route path="/ask" element={<Ask />} />
            <Route path="/graph" element={<Suspense fallback={<Skeleton className="h-[70vh] w-full rounded-2xl" />}><Graph /></Suspense>} />
            <Route path="/import" element={<Import />} />
            <Route path="/welcome" element={<Suspense fallback={<Skeleton className="h-[60vh] w-full rounded-2xl" />}><Welcome /></Suspense>} />
            <Route path="/automations" element={<Automations />} />
            <Route path="/analytics" element={<Suspense fallback={<Skeleton className="h-[60vh] w-full rounded-2xl" />}><Analytics /></Suspense>} />
            <Route path="/settings" element={<Settings />} />
            {auth.hosted && <Route path="/billing" element={<Suspense fallback={<Skeleton className="h-[60vh] w-full rounded-2xl" />}><Billing /></Suspense>} />}
            <Route path="/pricing" element={<Navigate to={auth.hosted ? '/billing' : '/'} replace />} />
            <Route path="/login" element={<Navigate to={(loc.state as any)?.from && String((loc.state as any).from).startsWith('/') ? String((loc.state as any).from) : '/'} replace />} />
            <Route path="/signup" element={<Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
        <ItemModal />
        <CommandPalette />
        {auth.hosted && <UpgradeModal />}
      </PaletteProvider>
    </ItemModalProvider>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <QuotaProvider>
          <Gate />
        </QuotaProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
