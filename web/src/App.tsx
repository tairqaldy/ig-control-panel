import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { AuthProvider, ItemModalProvider, PaletteProvider, ThemeProvider, useAuth } from './lib/store';
import { Shell } from './components/Shell';
import { ItemModal } from './components/ItemModal';
import { CommandPalette } from './components/CommandPalette';
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

function Gate() {
  const auth = useAuth();
  const loc = useLocation();
  if (auth.loading) {
    return (
      <div className="h-full grid place-items-center">
        <div className="flex items-center gap-3 text-muted text-sm"><span className="h-2 w-2 rounded-full bg-accent pulse-dot" /> Loading…</div>
      </div>
    );
  }
  if (!auth.authenticated) return <Login />;
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
            <Route path="/automations" element={<Automations />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/login" element={<Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
        <ItemModal />
        <CommandPalette />
      </PaletteProvider>
    </ItemModalProvider>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </ThemeProvider>
  );
}
