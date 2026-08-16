import { useState } from 'react';
import { Link } from 'react-router';
import { CheckCircle2, Radio, Unplug, ArrowRight, MessageCircle, BarChart3, Zap, KeyRound, ExternalLink } from 'lucide-react';
import { useAuth } from '../../lib/store';
import { cn, fmtAgo, fmtNum } from '../../lib/utils';
import { Modal, Skeleton } from '../ui';
import { AccountBadge } from './AccountBadge';
import { InstagramGlyph } from './icons';
import { startInstagramConnect, useDisconnectInstagram, useIgAccount } from './useIgAccount';

/**
 * The Instagram connection card (ROUND5-SPEC §2 / §5). Three states:
 *  - not configured (no META_APP_ID on this server): explains hosted one-click vs. self-host credentials in Settings
 *  - not connected: "Connect Instagram" + the 3 things that happen after
 *  - connected: avatar, @username, followers, "Webhooks live", Disconnect
 * `compact` = one-row variant for Settings / onboarding. `showSettingsLink` hides the "Settings → Integrations" pointer when we're already there.
 */
export function ConnectCard({ compact = false, className, showSettingsLink = true }: { compact?: boolean; className?: string; showSettingsLink?: boolean }) {
  const auth = useAuth();
  const q = useIgAccount();
  const disconnect = useDisconnectInstagram();
  const [confirm, setConfirm] = useState(false);
  const d = q.data;

  if (q.isLoading && !d) return <Skeleton className={cn(compact ? 'h-16' : 'h-32', className)} />;

  const account = d?.account ?? null;
  const connected = !!d?.connected;
  const configured = !!d?.configured;

  /* ---------- connected ---------- */
  if (connected) {
    const webhooks = !!account?.webhookSubscribed;
    return (
      <div className={cn('card p-4 sm:p-5', className)}>
        <div className="flex flex-wrap items-center gap-4">
          <AccountBadge size={compact ? 'md' : 'lg'} username={account?.username} name={account?.name} profilePictureUrl={account?.profilePictureUrl} followers={account?.followersCount}
            subtitle={<>{account?.followersCount != null ? `${fmtNum(account.followersCount)} followers` : ''}{account?.mediaCount != null ? ` · ${fmtNum(account.mediaCount)} posts` : ''}{account?.accountType ? ` · ${account.accountType.toLowerCase().replace('_', ' ')}` : ''}</>} />
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="chip chip-active"><CheckCircle2 size={12} /> Connected{d?.source === 'env' ? ' (env credentials)' : ''}</span>
            <span className={cn('chip', webhooks ? 'border-accent/40 text-accent' : 'text-muted')}><Radio size={12} className={cn(webhooks && 'text-accent')} /> {webhooks ? 'Webhooks live' : 'Webhooks pending'}</span>
            {account?.tokenExpiresAt ? <span className="text-[11.5px] text-muted">token renews automatically · expires {fmtAgo(account.tokenExpiresAt)}</span> : null}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {!compact && <Link to="/analytics" className="btn btn-sm"><BarChart3 size={13} /> Analytics</Link>}
            <button onClick={() => setConfirm(true)} className="btn btn-ghost btn-sm text-muted hover:text-danger"><Unplug size={13} /> Disconnect</button>
          </div>
        </div>
        <Modal open={confirm} onClose={() => setConfirm(false)} width="max-w-md">
          <div className="p-6">
            <div className="eyebrow mb-1">Instagram</div>
            <h3 className="display text-[24px] mb-2">Disconnect @{account?.username || 'this account'}?</h3>
            <p className="text-[13px] text-ink-2 leading-relaxed">Automations stop receiving DMs and comments, and analytics stop refreshing. Your rules and saved analytics stay; reconnect any time.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirm(false)} className="btn">Keep connected</button>
              <button onClick={() => { disconnect.mutate(undefined, { onSettled: () => setConfirm(false) }); }} disabled={disconnect.isPending} className="btn btn-danger">{disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}</button>
            </div>
          </div>
        </Modal>
      </div>
    );
  }

  /* ---------- not configured on this server ---------- */
  if (!configured) {
    return (
      <div className={cn('card p-4 sm:p-5 border-dashed', className)}>
        <div className="flex flex-wrap items-start gap-4">
          <div className="h-10 w-10 shrink-0 grid place-items-center rounded-xl bg-surface-2 text-muted"><InstagramGlyph size={18} /></div>
          <div className="min-w-[240px] flex-1">
            <div className="text-[14px] font-medium">Instagram is not connected</div>
            <p className="mt-1 text-[12.5px] text-muted leading-relaxed">
              {d?.unavailable
                ? 'This server does not have the Instagram connect endpoint yet — update Resurfly, or use your own Meta app below.'
                : auth.hosted
                  ? 'The hosted version connects with one click once the operator adds the Meta app id and secret on the server.'
                  : <>The hosted version connects with one click; self-hosters paste their Meta app credentials in Settings → Integrations (Instagram user id, access token, verify token, app secret). Set <code className="font-mono">META_APP_ID</code> and <code className="font-mono">META_APP_SECRET</code> on the server to get the one-click flow here too.</>}
            </p>
          </div>
          {showSettingsLink && (
            <div className="flex flex-col gap-2">
              <Link to="/settings#integrations" className="btn btn-sm"><KeyRound size={13} /> Enter Meta credentials <ArrowRight size={12} /></Link>
              <a href="https://github.com/tairqaldy/resurfly/blob/main/docs/AUTOMATIONS.md" target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm text-muted"><ExternalLink size={12} /> Setup guide</a>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ---------- configured, not connected ---------- */
  return (
    <div className={cn('card p-4 sm:p-5', className)}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="h-10 w-10 shrink-0 grid place-items-center rounded-xl bg-accent-soft text-accent"><InstagramGlyph size={18} /></div>
        <div className="min-w-[240px] flex-1">
          <div className="text-[14px] font-medium">Connect your Instagram account</div>
          <p className="mt-1 text-[12.5px] text-muted leading-relaxed">You log in with Instagram (professional account — Business or Creator) and approve four permissions. Takes about 20 seconds.</p>
          {!compact && (
            <ul className="mt-3 grid sm:grid-cols-3 gap-2 text-[12.5px]">
              {[
                { icon: MessageCircle, t: 'DMs and comments arrive here', d: 'Webhooks are subscribed for you.' },
                { icon: Zap, t: 'Three starter rules appear', d: 'Off by default. Edit, then switch on.' },
                { icon: BarChart3, t: 'Analytics start filling', d: 'Followers, reach, best time to post.' },
              ].map((x) => (
                <li key={x.t} className="rounded-xl border border-line bg-surface-2/60 px-3 py-2">
                  <div className="flex items-center gap-1.5 font-medium text-ink"><x.icon size={13} className="text-accent" />{x.t}</div>
                  <div className="text-muted mt-0.5">{x.d}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <button onClick={startInstagramConnect} className="btn btn-primary"><InstagramGlyph size={14} /> Connect Instagram</button>
          {showSettingsLink && !compact && <Link to="/settings#integrations" className="btn btn-ghost btn-sm text-muted">Use my own Meta app instead</Link>}
        </div>
      </div>
    </div>
  );
}
