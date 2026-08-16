/* Device-less rounded frame for the dark product screenshots (web/public/landing/shots/*.jpg).
   The shots may not exist yet (they are captured separately): on 404 the frame either disappears
   (`fallback="hide"`, default) or keeps its box as a neutral dark plate (`fallback="placeholder"`)
   so the layout around it does not jump. */
import { type ReactNode, useState } from 'react';
import { cn } from '../../lib/utils';

export const SHOTS = {
  overview: '/landing/shots/overview.jpg',
  ask: '/landing/shots/ask.jpg',
  library: '/landing/shots/library.jpg',
  graph: '/landing/shots/graph.jpg',
  automations: '/landing/shots/automations.jpg',
  analytics: '/landing/shots/analytics.jpg',
  save: '/landing/shots/save.jpg',
} as const;

export function Frame({ src, alt, width = 1440, height = 900, priority, fallback = 'hide', className, imgClassName, children, onFail }: {
  src: string; alt: string; width?: number; height?: number;
  /** hero image: eager + high fetch priority (LCP); everything else is lazy */
  priority?: boolean;
  fallback?: 'hide' | 'placeholder';
  className?: string; imgClassName?: string;
  /** overlays (captions, vignettes) rendered inside the frame */
  children?: ReactNode;
  onFail?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  if (failed && fallback === 'hide') return null;
  return (
    <figure className={cn('mk-frame', className)} style={{ aspectRatio: `${width} / ${height}` }}>
      {failed ? (
        <div className="absolute inset-0 mk-dark" aria-hidden>
          {/* neutral plate: a faint chrome bar and a few skeleton lines, nothing that pretends to be the product */}
          <div className="h-8 border-b border-line flex items-center gap-1.5 px-3"><span className="h-2 w-2 rounded-full bg-line-2" /><span className="h-2 w-2 rounded-full bg-line-2" /><span className="h-2 w-2 rounded-full bg-line-2" /></div>
          <div className="p-6 space-y-3 max-w-md">
            <div className="h-3 w-2/3 rounded bg-surface-2" /><div className="h-3 w-1/2 rounded bg-surface-2" /><div className="h-3 w-3/5 rounded bg-surface-2" />
          </div>
        </div>
      ) : (
        <img
          src={src} alt={alt} width={width} height={height}
          loading={priority ? 'eager' : 'lazy'} decoding="async" fetchPriority={priority ? 'high' : 'auto'}
          onError={() => { setFailed(true); onFail?.(); }}
          className={cn('absolute inset-0 h-full w-full object-cover object-top', imgClassName)}
        />
      )}
      {children}
    </figure>
  );
}
