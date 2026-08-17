/* The paste form. Scoring must work for someone who cannot connect Instagram (the Meta app is not Live
   for everyone yet), so this is never a dead end and never tells anyone to go and connect first. */
import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { BIO_MAX, type ProfileSubject } from '../../lib/types-profile';
import { cn } from '../../lib/utils';
import { Field } from '../ui';

export interface ManualValues { username: string; name: string; bio: string; link: string }

export function toManualValues(p: ProfileSubject | null | undefined): ManualValues {
  return { username: p?.username ?? '', name: p?.name ?? '', bio: p?.bio ?? '', link: p?.link ?? '' };
}

export function ManualProfile({ initial, onSubmit, onCancel, busy, connected, submitLabel = 'Score my profile', title = 'What is on your profile now?' }: {
  initial?: ManualValues;
  onSubmit: (v: ManualValues) => void;
  onCancel?: () => void;
  busy?: boolean;
  /** an Instagram account is connected — only the fields the API never returns are missing */
  connected?: boolean;
  submitLabel?: string;
  title?: string;
}) {
  const [v, setV] = useState<ManualValues>(initial ?? { username: '', name: '', bio: '', link: '' });
  const set = (k: keyof ManualValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  const over = v.bio.length > BIO_MAX;
  /* Exactly what the server will accept (`canScore`): a bio, plus a handle or a name to attach it to. The form used
     to enable itself on a name alone and promise "a name is enough", then the run came back 400 and bounced the
     person into the same form. The bio is not optional because the score leans on it hardest and Instagram's API
     never returns it. */
  const enough = !!(v.bio.trim() && (v.username.trim() || v.name.trim()));
  return (
    <form
      className="mx-auto w-full max-w-xl card p-5 sm:p-6"
      onSubmit={(e) => { e.preventDefault(); if (enough && !busy) onSubmit(v); }}
    >
      <h2 className="display text-[22px] leading-tight">{title}</h2>
      <p className="mt-1.5 text-[13px] text-muted leading-relaxed">
        {connected
          ? 'Instagram never hands over your bio text or your link, so paste those two here. The handle and name came from your account — correct them if they are out of date.'
          : 'Copy the four fields from your profile exactly as they are. The score reads the same either way; nothing here needs a connection.'}
      </p>
      <div className="mt-5 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Handle">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-muted">@</span>
              <input className="input !pl-7" value={v.username} onChange={set('username')} placeholder="yourhandle" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            </div>
          </Field>
          <Field label="Name" hint="The bold line under your photo — searchable on Instagram.">
            <input className="input" value={v.name} onChange={set('name')} placeholder="Your name or what you do" />
          </Field>
        </div>
        <Field label="Bio" hint={<span className={cn('font-mono tabular', over && 'text-warn')}>{v.bio.length}/{BIO_MAX} characters</span>}>
          <textarea className="input min-h-[92px] resize-y leading-relaxed" value={v.bio} onChange={set('bio')} placeholder="Paste your bio exactly as it is now, line breaks and all" />
        </Field>
        <Field label="Link" hint="Whatever the link in bio points at right now.">
          <input className="input" value={v.link} onChange={set('link')} placeholder="https://" inputMode="url" autoCapitalize="none" spellCheck={false} />
        </Field>
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        {onCancel ? <button type="button" onClick={onCancel} className="text-[12.5px] text-muted hover:text-ink transition-colors">Cancel</button> : <span />}
        <button type="submit" disabled={!enough || busy} className="btn btn-primary">
          {busy ? 'Working…' : submitLabel} <ArrowRight size={13} />
        </button>
      </div>
      {!enough && (
        <p className="mt-2 text-right text-[12px] text-muted">
          {v.bio.trim() ? 'Add your handle (or the name on the account) to start.' : 'Your bio and a handle are what the score needs to start.'}
        </p>
      )}
    </form>
  );
}
