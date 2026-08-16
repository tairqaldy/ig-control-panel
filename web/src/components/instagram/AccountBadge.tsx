import { InstagramGlyph } from './icons';
import { cn, fmtNum } from '../../lib/utils';

/**
 * Avatar + @username (+ followers) — the compact identity chip for a connected Instagram account.
 * Used in the Connect card, the Analytics header and Settings. Falls back to an Instagram glyph when there is no picture.
 */
export function AccountBadge({ username, name, profilePictureUrl, followers, size = 'md', className, subtitle }: {
  username?: string | null; name?: string | null; profilePictureUrl?: string | null; followers?: number | null;
  size?: 'sm' | 'md' | 'lg'; className?: string; subtitle?: React.ReactNode;
}) {
  const px = size === 'lg' ? 48 : size === 'sm' ? 24 : 36;
  return (
    <span className={cn('inline-flex items-center gap-2.5 min-w-0 align-middle', className)}>
      <span className="relative shrink-0 rounded-full border border-line bg-surface-2 overflow-hidden grid place-items-center text-muted" style={{ width: px, height: px }}>
        {profilePictureUrl ? <img src={profilePictureUrl} alt="" width={px} height={px} className="h-full w-full object-cover" referrerPolicy="no-referrer" /> : <InstagramGlyph size={Math.round(px * 0.5)} />}
      </span>
      <span className="min-w-0 leading-tight">
        <span className={cn('block truncate font-medium', size === 'lg' ? 'text-[16px]' : size === 'sm' ? 'text-[12.5px]' : 'text-[14px]')}>{username ? `@${username}` : name || 'Instagram'}</span>
        <span className={cn('block truncate text-muted', size === 'sm' ? 'text-[11px]' : 'text-[12px]')}>
          {subtitle ?? <>{name && username ? `${name} · ` : ''}{followers !== null && followers !== undefined ? `${fmtNum(followers)} followers` : ''}</>}
        </span>
      </span>
    </span>
  );
}
