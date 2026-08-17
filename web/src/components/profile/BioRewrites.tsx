/* Three ready-to-paste bios. The only interaction that matters here is Copy. */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { BIO_MAX, type BioRewrite } from '../../lib/types-profile';
import { cn, copyText } from '../../lib/utils';

export function BioRewrites({ rewrites, current }: { rewrites: BioRewrite[]; current?: string | null }) {
  const [copied, setCopied] = useState<number | null>(null);
  if (!rewrites.length) return null;
  const copy = async (text: string, i: number) => {
    await copyText(text);
    setCopied(i);
    toast.success('Bio copied — paste it into Edit profile on Instagram');
    window.setTimeout(() => setCopied((c) => (c === i ? null : c)), 2000);
  };
  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <div className="eyebrow">Three bios in your voice</div>
        <span className="text-[11.5px] text-muted">Instagram allows {BIO_MAX} characters</span>
      </div>
      {current && <p className="mb-3 text-[12.5px] text-muted leading-relaxed">Now: <span className="text-ink-2 whitespace-pre-wrap">{current}</span></p>}
      <div className="grid gap-3 md:grid-cols-3">
        {rewrites.map((b, i) => {
          const over = b.text.length > BIO_MAX;
          return (
            <div key={`${i}-${b.text.slice(0, 12)}`} className="card-flat flex flex-col p-3.5">
              {b.angle && <div className="eyebrow !text-[10px] mb-1.5">{b.angle}</div>}
              <p className="flex-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{b.text}</p>
              <div className="mt-3 flex items-center justify-between gap-2">
                <span className={cn('font-mono text-[11px] tabular', over ? 'text-warn' : 'text-muted')}>{b.text.length}/{BIO_MAX}</span>
                <button type="button" onClick={() => void copy(b.text, i)} className="btn btn-sm">
                  {copied === i ? <><Check size={12} className="text-accent" /> Copied</> : <><Copy size={12} /> Copy</>}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
