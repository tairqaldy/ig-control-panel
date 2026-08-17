/* Round 7 §3/§5 — when connecting Instagram is currently impossible, say so instead of offering a
   button that fails. The sentence comes from GET /api/instagram/availability; we add what still works. */
import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BellRing, Check, ExternalLink, KeyRound, PauseCircle, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { cn } from '../../lib/utils';
import { InstagramGlyph } from './icons';
import type { IgAvailability } from './useAutomations';

const HEADLINE: Record<string, string> = {
  development: 'Connecting Instagram is waiting on Meta',
  unconfigured: 'Instagram connecting is not set up on this server',
};

export interface IgAvailabilityNoticeProps {
  availability: IgAvailability;
  /** what the person can still do here, one sentence — differs per page */
  stillWorks: string;
  className?: string;
}

export function IgAvailabilityNotice({ availability, stillWorks, className }: IgAvailabilityNoticeProps) {
  const qc = useQueryClient();
  const [joined, setJoined] = useState(!!availability.waitlist);
  const [email, setEmail] = useState<string | null>(availability.waitlistEmail ?? null);
  const waitlist = useMutation({
    mutationFn: () => api.post<{ email?: string | null; message?: string }>('/api/instagram/waitlist', {}),
    onSuccess: (r) => {
      setJoined(true);
      setEmail(r?.email ?? null);
      toast.success(r?.message || 'Noted — we will e-mail you when Instagram connecting opens.');
      // the prefix matches the onboarding wizard's key too, so both screens agree from here on
      void qc.invalidateQueries({ queryKey: ['ig-availability'] });
    },
    onError: (e: unknown) => {
      // an older server has no waitlist endpoint; say that rather than pretending it was recorded
      if (e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501)) { toast.error('This server cannot take your name yet. Write to hello@resurfly.com and we will add you.'); return; }
      toast.error(e instanceof Error ? e.message : 'Could not record that');
    },
  });

  /**
   * Taking yourself back off the list. `/privacy` states that the same screen that stored the address deletes it
   * again, and it was the only self-service withdrawal of consent we promised and did not build: the endpoint
   * existed, no button in the app ever called it, and the only way off the list was deleting the whole account.
   */
  const leave = useMutation({
    mutationFn: () => api.del('/api/instagram/waitlist'),
    onSuccess: () => {
      setJoined(false);
      setEmail(null);
      toast.success('Taken off the list — your address is deleted.');
      void qc.invalidateQueries({ queryKey: ['ig-availability'] });
    },
    onError: (e: unknown) => {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501)) { toast.error('This server cannot remove it yet. Write to hello@resurfly.com and we will delete it.'); return; }
      toast.error(e instanceof Error ? e.message : 'Could not remove it');
    },
  });

  const selfHost = availability.mode === 'unconfigured';
  return (
    <section className={cn('card p-4 sm:p-5 border-warn/40', className)}>
      <div className="flex flex-wrap items-start gap-4">
        <span className="h-10 w-10 shrink-0 grid place-items-center rounded-xl bg-warn-soft text-warn"><InstagramGlyph size={18} /></span>
        <div className="min-w-[240px] flex-1">
          <div className="text-[14px] font-medium">{HEADLINE[availability.mode] || 'Instagram cannot be connected right now'}</div>
          <p className="mt-1 text-[12.5px] text-ink-2 leading-relaxed">
            {availability.reason || 'Our Meta app is still in review, so Instagram accounts cannot be connected yet.'}
          </p>
          <p className="mt-1.5 flex items-start gap-1.5 text-[12.5px] text-muted leading-relaxed">
            <PauseCircle size={13} className="mt-[3px] shrink-0" /> {stillWorks}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          {selfHost ? (
            <>
              <Link to="/settings#integrations" className="btn btn-sm"><KeyRound size={13} /> Use my own Meta app</Link>
              <a href="https://github.com/tairqaldy/resurfly/blob/main/docs/AUTOMATIONS.md" target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm text-muted"><ExternalLink size={12} /> Setup guide</a>
            </>
          ) : joined ? (
            <>
              <span className="chip chip-active !py-1.5"><Check size={12} /> {email ? `We will e-mail ${email}` : 'We will e-mail you'}</span>
              <button onClick={() => leave.mutate()} disabled={leave.isPending} className="btn btn-ghost btn-sm text-muted">
                <X size={12} /> {leave.isPending ? 'Removing…' : 'Take me off the list'}
              </button>
            </>
          ) : availability.waitlistOffered === false ? null : (
            <button onClick={() => waitlist.mutate()} disabled={waitlist.isPending} className="btn btn-sm">
              <BellRing size={13} /> {waitlist.isPending ? 'Noting it…' : 'Tell me when it opens'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
