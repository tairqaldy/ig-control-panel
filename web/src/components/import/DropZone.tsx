import { useRef, useState } from 'react';
import { Upload, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

export function DropZone({ accept, onFile, label, hint, busy, className }: { accept: string; onFile: (f: File) => void; label: string; hint: string; busy?: boolean; className?: string }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
      onClick={() => inputRef.current?.click()}
      role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
      aria-busy={busy || undefined}
      className={cn('cursor-pointer rounded-2xl border-2 border-dashed p-6 sm:p-8 text-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/30', over ? 'border-accent bg-accent-soft/40' : busy ? 'border-accent/40 bg-surface' : 'border-line hover:border-line-2 bg-surface', className)}
    >
      <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      {busy ? <Loader2 className="mx-auto mb-2 animate-spin text-accent" /> : <Upload className="mx-auto mb-2 text-muted" />}
      <div className="text-[14px] font-medium">{busy ? 'Uploading and importing…' : label}</div>
      <div className="text-[12px] text-muted mt-1">{busy ? 'Large files take a minute. Keep this tab open.' : hint}</div>
    </div>
  );
}
