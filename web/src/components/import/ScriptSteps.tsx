import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, Bookmark, FileJson } from 'lucide-react';
import { api } from '../../lib/api';
import { cn, copyText } from '../../lib/utils';
import { DropZone } from './DropZone';
import { useImports } from './useImports';

/** Loads /harvester.js and personalises it with a 24 h upload token; returns the console script + bookmarklet href. */
export function useHarvesterScript() {
  const [script, setScript] = useState<string>('');
  const token = useQuery({ queryKey: ['upload-token'], queryFn: () => api.post<{ token: string; expiresAt: number }>('/api/import/token'), staleTime: 60 * 60_000 });
  useEffect(() => { fetch('/harvester.js').then((r) => r.text()).then(setScript).catch(() => {}); }, []);
  // The script we hand out embeds a private 24h upload token so the harvester can "Send to Resurfly" directly.
  const personalScript = script ? script.replace(/__RESURFLY_TOKEN__/g, token.data?.token || '__RESURFLY_TOKEN__') : '';
  const bookmarklet = personalScript ? `javascript:${encodeURIComponent(personalScript.replace(/^\/\*[\s\S]*?\*\/\s*/, ''))}` : '';
  return { script: personalScript, bookmarklet, ready: !!script };
}

/**
 * Import → 2. One-time script: the console/bookmarklet harvester + the JSON drop zone. `compact` hides the privacy footnote
 * and the "how it works" numbering details (Welcome). Handles the upload itself (useImports).
 */
export function ScriptSteps({ autoAnalyze = true, compact = false, className, onImported }: { autoAnalyze?: boolean; compact?: boolean; className?: string; onImported?: () => void }) {
  const { script, bookmarklet, ready } = useHarvesterScript();
  const bookmarkletRef = useRef<HTMLAnchorElement>(null);
  const { harvest } = useImports({ autoAnalyze, onDone: onImported });
  // React refuses to render javascript: URLs in href — set it through the DOM so the drag-to-bookmarks-bar gesture keeps the real code.
  useEffect(() => { if (bookmarkletRef.current) bookmarkletRef.current.setAttribute('href', bookmarklet || '#'); }, [bookmarklet]);
  const copyScript = useCallback(() => { void copyText(script); toast.success('Harvester script copied — paste it into the DevTools console on instagram.com'); }, [script]);

  return (
    <div className={cn('grid lg:grid-cols-[1.1fr_1fr] gap-4', className)}>
      <div className={compact ? '' : 'card p-6'}>
        {!compact && <div className="eyebrow mb-3">How it works</div>}
        <ol className="space-y-3.5 text-[13.5px]">
          {[
            ['Open instagram.com in a desktop browser', 'Logged in to the account whose saves you want.'],
            ['Run the harvester there', <>Click the bookmarklet on instagram.com, or open DevTools (F12 → Console), paste the script and press Enter. Chrome may ask you to type <code className="font-mono">allow pasting</code> first.</>],
            ['Press Start and wait', 'A small panel pages through your saves at about one request per second. A few thousand saves take 20–40 minutes; Stop and Start again later to resume.'],
            ['Send to Resurfly, or drop the JSON here', 'The script carries a private 24-hour upload token, so "Send to Resurfly" posts straight into this workspace. Or "Download JSON" and drop the file here. Media links expire in a few days, so do not wait.'],
          ].map(([t, d], i) => (
            <li key={i} className="flex gap-3"><span className="font-mono text-[11px] text-accent pt-1 w-5 shrink-0">{String(i + 1).padStart(2, '0')}</span><div><div className="font-medium">{t}</div><div className="text-muted mt-0.5 leading-relaxed">{d}</div></div></li>
          ))}
        </ol>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button onClick={copyScript} disabled={!ready} className="btn btn-primary"><Copy size={14} /> Copy console script</button>
          <a ref={bookmarkletRef} onClick={(e) => { e.preventDefault(); toast('Drag this button to your bookmarks bar, then click it on instagram.com'); }} draggable className={cn('btn', !bookmarklet && 'opacity-50')} title="Drag me to your bookmarks bar"><Bookmark size={14} /> Harvest saves (bookmarklet)</a>
          <a href="/harvester.js" target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm text-muted">View source</a>
        </div>
        {!compact && <div className="mt-4 text-[12px] text-muted leading-relaxed">Privacy: the script only talks to instagram.com with your own session and writes a file to your computer. It keeps to Instagram's rate limits and stops on errors.</div>}
      </div>
      <div className="flex flex-col gap-4">
        <DropZone accept=".json,application/json" onFile={(f) => harvest.mutate(f)} busy={harvest.isPending} label="Drop the harvester JSON here" hint="resurfly-harvest-YYYYMMDD.json · or click to choose" />
        {!compact && <div className="card-flat p-4 text-[12.5px] text-muted leading-relaxed"><FileJson size={14} className="inline mr-1.5 -mt-0.5 text-ink" />Re-running the harvester later only adds new saves and refreshes counts. Notes, favorites and analyses are kept.</div>}
      </div>
    </div>
  );
}
