import { useState } from 'react';
import { ArrowRight, Loader2, FileArchive, Link2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Field, Toggle } from '../ui';
import { DropZone } from './DropZone';
import { useImports } from './useImports';

/**
 * Import → 3. Advanced: the official Instagram data-export ZIP and pasted post/reel URLs. Handles its own uploads (useImports).
 */
export function AdvancedImport({ autoAnalyze = true, className, onImported }: { autoAnalyze?: boolean; className?: string; onImported?: () => void }) {
  const [includeLiked, setIncludeLiked] = useState(false);
  const [urls, setUrls] = useState('');
  const { exportZip, urls: upUrls } = useImports({ autoAnalyze, includeLiked, onDone: onImported });
  return (
    <div className={cn('grid lg:grid-cols-2 gap-4', className)}>
      <div className="card p-6">
        <div className="flex items-center gap-2 mb-3"><FileArchive size={15} className="text-accent" /><h3 className="text-[14px] font-semibold">Instagram data export (ZIP)</h3></div>
        <ol className="space-y-3 text-[13px]">
          {[
            ['Request your data', <>Instagram app → Settings → <b>Accounts Center</b> → Your information and permissions → <b>Download your information</b> → select your profile → <b>Some of your information</b> → tick <b>Saved</b> (and Likes if you want) → Download to device → format <b>JSON</b>, media quality low → Create files.</>],
            ['Wait for the email', 'Minutes to a couple of days. The ZIP can come in parts — upload each.'],
            ['Upload the ZIP here', 'We read saved_posts.json and saved_collections.json: links, save dates, collections. Captions and thumbnails come from public embed pages when available; for media and transcripts also run the Companion or the script — everything merges into the same saves.'],
          ].map(([t, d], i) => (
            <li key={i} className="flex gap-3"><span className="font-mono text-[11px] text-accent pt-0.5 w-5 shrink-0">{String(i + 1).padStart(2, '0')}</span><div><div className="font-medium">{t}</div><div className="text-muted mt-0.5 leading-relaxed">{d}</div></div></li>
          ))}
        </ol>
        <div className="mt-3 mb-4"><Toggle checked={includeLiked} onChange={setIncludeLiked} label="Also import liked posts (as a “Liked” collection)" /></div>
        <DropZone accept=".zip,application/zip" onFile={(f) => exportZip.mutate(f)} busy={exportZip.isPending} label="Drop the Instagram export ZIP here" hint="instagram-username-date-xxxx.zip (JSON format)" />
      </div>
      <div className="card p-6">
        <div className="flex items-center gap-2 mb-3"><Link2 size={15} className="text-accent" /><h3 className="text-[14px] font-semibold">Paste post / reel links</h3></div>
        <p className="text-[13px] text-muted leading-relaxed mb-3">One per line (or comma-separated). For saves from screenshots, DMs, or anything you want in the library without saving it on Instagram. Captions and thumbnails come from public embed pages when possible; reels may also be transcribed.</p>
        <Field label="Links">
          <textarea value={urls} onChange={(e) => setUrls(e.target.value)} rows={7} placeholder={'https://www.instagram.com/reel/AbC123/\nhttps://www.instagram.com/p/XyZ789/'} className="input font-mono text-[12px]" />
        </Field>
        <button onClick={() => upUrls.mutate(urls, { onSuccess: () => setUrls('') })} disabled={!urls.trim() || upUrls.isPending} className="btn btn-primary mt-3">{upUrls.isPending ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />} Import links</button>
      </div>
    </div>
  );
}
