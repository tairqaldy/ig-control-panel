import { useEffect, useState } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { LayoutGrid, Library, MessageSquareText, Sparkles, Waypoints, Upload, Bot, Settings, Search, Tag, User, Sun, Moon, FileText } from 'lucide-react';
import { api, qs } from '../lib/api';
import { useItemModal, usePalette, useTheme } from '../lib/store';
import type { Facets, ItemsResponse } from '../lib/types';
import { useDebounced } from './ui';

export function CommandPalette() {
  const { open, setOpen } = usePalette();
  const nav = useNavigate();
  const modal = useItemModal();
  const { toggle, theme } = useTheme();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  useEffect(() => { if (!open) setQ(''); }, [open]);
  const items = useQuery({ queryKey: ['palette-items', dq], queryFn: () => api.get<ItemsResponse>(`/api/items${qs({ q: dq, limit: 8 })}`), enabled: open && dq.length >= 2 });
  const facets = useQuery({ queryKey: ['facets'], queryFn: () => api.get<Facets>('/api/facets'), enabled: open, staleTime: 60_000 });
  const go = (fn: () => void) => { setOpen(false); fn(); };
  const tags = (facets.data?.tags || []).filter((t) => !dq || t.name.includes(dq.toLowerCase())).slice(0, 6);
  const authors = (facets.data?.authors || []).filter((t) => !dq || t.name.toLowerCase().includes(dq.toLowerCase())).slice(0, 4);

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[90] flex items-start justify-center pt-[12vh] px-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
          <div className="fixed inset-0 bg-ink/30 dark:bg-black/60 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
          <motion.div initial={{ opacity: 0, y: -8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.98 }} transition={{ type: 'spring', stiffness: 500, damping: 38 }} className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface" style={{ boxShadow: 'var(--shadow-lg)' }}>
            <Command label="Command palette" shouldFilter={false} loop>
              <div className="flex items-center gap-2 border-b border-line px-4">
                <Search size={16} className="text-muted" />
                <Command.Input value={q} onValueChange={setQ} autoFocus placeholder="Search saves, tags, authors… or jump to a page" className="w-full bg-transparent py-3.5 text-[14px] outline-none placeholder:text-muted-2" />
                <kbd className="kbd">esc</kbd>
              </div>
              <Command.List className="max-h-[60vh] overflow-y-auto p-2 [&_[cmdk-group-heading]]:eyebrow [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
                <Command.Empty className="px-3 py-8 text-center text-[13px] text-muted">Nothing found.</Command.Empty>
                {items.data?.items.length ? (
                  <Command.Group heading="Saves">
                    {items.data.items.map((it) => (
                      <Item key={it.id} onSelect={() => go(() => modal.open(it.id))}>
                        <div className="h-9 w-7 shrink-0 overflow-hidden rounded bg-surface-2">{it.thumb ? <img src={it.thumb} className="h-full w-full object-cover" alt="" /> : <FileText size={12} className="m-auto mt-3 text-muted" />}</div>
                        <div className="min-w-0"><div className="truncate text-[13px]">{it.analysis?.title || it.caption?.slice(0, 80) || it.author}</div><div className="truncate text-[11.5px] text-muted">{it.author ? `@${it.author}` : ''}{it.analysis ? ` · ${it.analysis.category}` : ''}</div></div>
                      </Item>
                    ))}
                    {dq && <Item onSelect={() => go(() => nav(`/library?q=${encodeURIComponent(dq)}`))}><Search size={14} className="text-muted" /><span className="text-[13px]">Search library for “{dq}”</span></Item>}
                  </Command.Group>
                ) : dq.length >= 2 ? (
                  <Command.Group heading="Saves"><Item onSelect={() => go(() => nav(`/library?q=${encodeURIComponent(dq)}`))}><Search size={14} className="text-muted" /><span className="text-[13px]">Search library for “{dq}”</span></Item><Item onSelect={() => go(() => nav(`/ask?q=${encodeURIComponent(dq)}`))}><MessageSquareText size={14} className="text-muted" /><span className="text-[13px]">Ask your saves: “{dq}”</span></Item></Command.Group>
                ) : null}
                {tags.length > 0 && (
                  <Command.Group heading="Tags">
                    {tags.map((t) => <Item key={t.name} onSelect={() => go(() => nav(`/library?tag=${encodeURIComponent(t.name)}`))}><Tag size={14} className="text-muted" /><span className="text-[13px]">#{t.name}</span><span className="ml-auto font-mono text-[11px] text-muted">{t.n}</span></Item>)}
                  </Command.Group>
                )}
                {authors.length > 0 && (
                  <Command.Group heading="Authors">
                    {authors.map((t) => <Item key={t.name} onSelect={() => go(() => nav(`/library?author=${encodeURIComponent(t.name)}`))}><User size={14} className="text-muted" /><span className="text-[13px]">@{t.name}</span><span className="ml-auto font-mono text-[11px] text-muted">{t.n}</span></Item>)}
                  </Command.Group>
                )}
                <Command.Group heading="Go to">
                  {[
                    { l: 'Overview', to: '/', I: LayoutGrid }, { l: 'Library', to: '/library', I: Library }, { l: 'Resurface', to: '/resurface', I: Sparkles }, { l: 'Ask', to: '/ask', I: MessageSquareText },
                    { l: 'Graph', to: '/graph', I: Waypoints }, { l: 'Import', to: '/import', I: Upload }, { l: 'Automations', to: '/automations', I: Bot }, { l: 'Settings', to: '/settings', I: Settings },
                  ].filter((p) => !dq || p.l.toLowerCase().includes(dq.toLowerCase())).map((p) => (
                    <Item key={p.to} onSelect={() => go(() => nav(p.to))}><p.I size={14} className="text-muted" /><span className="text-[13px]">{p.l}</span></Item>
                  ))}
                  <Item onSelect={() => go(toggle)}>{theme === 'dark' ? <Sun size={14} className="text-muted" /> : <Moon size={14} className="text-muted" />}<span className="text-[13px]">Switch to {theme === 'dark' ? 'light' : 'dark'} theme</span></Item>
                </Command.Group>
              </Command.List>
            </Command>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Item({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) {
  return (
    <Command.Item onSelect={onSelect} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-ink aria-selected:bg-surface-2 aria-selected:text-ink data-[selected=true]:bg-surface-2">
      {children}
    </Command.Item>
  );
}
