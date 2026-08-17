/* Round 6 §2 — the phone-style preview of what the person actually receives.
   Renders {{username}} the same way the server's composeReply() does, and appends the link on its own line. */
import { ChevronLeft, Phone, Video } from 'lucide-react';
import { renderReply } from '../../lib/types-automations';
import { cn } from '../../lib/utils';
import { InstagramGlyph } from './icons';

export interface DmPreviewProps {
  /** the person receiving the DM — used for {{username}} and the header */
  username?: string | null;
  /** what they sent (comment or DM) — drawn as the incoming bubble */
  incoming?: string | null;
  /** the DM body, before {{username}} substitution */
  text: string;
  /** appended on its own line, like the server does */
  link?: string;
  /** shown as a comment reply above the DM, for comment rules */
  publicReply?: string;
  /** your own handle, shown in the "sent by" line */
  accountUsername?: string | null;
  className?: string;
  /** what the incoming bubble is: a comment on a post, a DM, a story reply */
  kind?: 'comment' | 'dm' | 'story_reply';
}

export function DmPreview({ username, incoming, text, link = '', publicReply = '', accountUsername, className, kind = 'dm' }: DmPreviewProps) {
  const handle = (username || 'their_handle').replace(/^@/, '');
  const body = renderReply(text, link, handle);
  const lines = body.split('\n');
  return (
    <div className={cn('select-none', className)}>
      <div className="mx-auto w-full max-w-[280px] rounded-[26px] border border-line bg-surface-2 p-[6px]" style={{ boxShadow: 'var(--shadow)' }}>
        <div className="rounded-[21px] bg-surface overflow-hidden border border-line/70">
          {/* status + thread header */}
          <div className="flex items-center justify-between px-3 pt-2 pb-1 text-[9px] font-mono text-muted-2">
            <span>9:41</span>
            <span className="flex items-center gap-1"><span className="h-1 w-1 rounded-full bg-muted-2" /><span className="h-1 w-1 rounded-full bg-muted-2" /><span className="h-1 w-1 rounded-full bg-muted-2" /></span>
          </div>
          <div className="flex items-center gap-2 px-2.5 py-2 border-b border-line">
            <ChevronLeft size={14} className="text-muted shrink-0" />
            <span className="h-6 w-6 shrink-0 rounded-full bg-surface-2 border border-line grid place-items-center text-muted"><InstagramGlyph size={11} /></span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[11.5px] font-medium">{handle}</span>
              <span className="block truncate text-[9.5px] text-muted">Instagram</span>
            </span>
            <Phone size={12} className="text-muted-2 shrink-0" />
            <Video size={12} className="text-muted-2 shrink-0" />
          </div>

          {/* thread */}
          <div className="px-2.5 py-3 space-y-2 min-h-[190px] flex flex-col justify-end">
            {kind === 'comment' && (
              <div className="text-[9px] font-mono uppercase tracking-wider text-muted-2 text-center">on your post</div>
            )}
            {incoming ? (
              <div className="flex justify-start">
                <span className="max-w-[82%] rounded-2xl rounded-bl-md bg-surface-2 border border-line px-2.5 py-1.5 text-[11.5px] leading-snug text-ink-2 whitespace-pre-wrap break-words">{incoming}</span>
              </div>
            ) : null}
            {kind === 'comment' && publicReply.trim() ? (
              <div className="flex justify-end">
                <span className="max-w-[82%] rounded-2xl rounded-br-md border border-line bg-surface px-2.5 py-1.5 text-[11px] leading-snug text-muted whitespace-pre-wrap break-words">
                  <span className="block text-[8.5px] font-mono uppercase tracking-wider text-muted-2 mb-0.5">public comment reply</span>
                  {publicReply}
                </span>
              </div>
            ) : null}
            <div className="flex justify-end">
              {body.trim() ? (
                <span className="max-w-[86%] rounded-2xl rounded-br-md bg-accent px-2.5 py-1.5 text-[11.5px] leading-snug text-accent-ink break-words">
                  {lines.map((l, i) => (
                    <span key={i} className={cn('block', /^https?:\/\//i.test(l.trim()) && 'underline underline-offset-2 break-all')}>{l || ' '}</span>
                  ))}
                </span>
              ) : (
                <span className="max-w-[86%] rounded-2xl rounded-br-md border border-dashed border-line-2 px-2.5 py-1.5 text-[11px] leading-snug text-muted-2">Your DM shows up here as you type it.</span>
              )}
            </div>
            <div className="text-[9px] text-muted-2 text-right pr-1">Sent{accountUsername ? ` by @${accountUsername}` : ''} · just now</div>
          </div>

          {/* composer */}
          <div className="border-t border-line px-2.5 py-2">
            <div className="rounded-full border border-line bg-surface-2 px-3 py-1.5 text-[10.5px] text-muted-2">Message…</div>
          </div>
        </div>
      </div>
      <p className="mt-2 text-center text-[11px] text-muted">Preview only — nothing is sent from here.</p>
    </div>
  );
}
