import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatDistanceToNowStrict } from 'date-fns';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export const fmtNum = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
};

export const fmtDate = (unix: number | null | undefined): string => {
  if (!unix) return '';
  return new Date(unix * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

export const fmtAgo = (unix: number | null | undefined): string => {
  if (!unix) return '';
  try { return formatDistanceToNowStrict(new Date(unix * 1000), { addSuffix: true }); } catch { return ''; }
};

export const fmtDuration = (s: number | null | undefined): string => {
  if (!s) return '';
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m ? `${m}:${String(sec).padStart(2, '0')}` : `${sec}s`;
};

export const fmtBytes = (b: number): string => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

/** Category → deterministic hue for graph/badges. */
const CATEGORY_HUES: Record<string, number> = {
  'Business & Marketing': 28,
  'Content Creation & Social Media': 340,
  'Design & Visual Aesthetics': 280,
  'Tech, AI & Tools': 210,
  'Productivity & Mindset': 45,
  'Money & Finance': 95,
  'Health & Fitness': 160,
  'Food & Recipes': 15,
  'Travel & Places': 190,
  'Fashion & Style': 320,
  'Home & Interior': 60,
  'Art & Creativity': 260,
  'Music & Audio': 300,
  'Photography & Video Craft': 240,
  'Learning & Science': 200,
  'Relationships & Communication': 355,
  'Humor & Entertainment': 40,
  'Personal & Sentimental': 10,
  Other: 0,
};
export function categoryHue(cat: string | null | undefined): number {
  if (!cat) return 0;
  if (CATEGORY_HUES[cat] !== undefined) return CATEGORY_HUES[cat];
  let h = 0;
  for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) % 360;
  return h;
}
export function categoryColor(cat: string | null | undefined, dark = false, alpha = 1): string {
  if (!cat) return dark ? `oklch(0.6 0.02 60 / ${alpha})` : `oklch(0.55 0.02 60 / ${alpha})`;
  const h = categoryHue(cat);
  return dark ? `oklch(0.72 0.12 ${h} / ${alpha})` : `oklch(0.52 0.12 ${h} / ${alpha})`;
}

export const CONTENT_TYPE_LABEL: Record<string, string> = {
  tutorial: 'Tutorial', tips_list: 'Tips list', story: 'Story', opinion: 'Opinion', quote: 'Quote', meme: 'Meme', aesthetic: 'Aesthetic', recipe: 'Recipe',
  product_showcase: 'Product', place_showcase: 'Place', tool_demo: 'Tool demo', news: 'News', workout: 'Workout', before_after: 'Before/after', interview_clip: 'Interview',
  motivational: 'Motivational', music_performance: 'Music', personal_moment: 'Personal', ad_promo: 'Ad', other: 'Other',
};
export const ACTION_LABEL: Record<string, string> = { try: 'Try it', buy: 'Buy', visit: 'Visit', learn: 'Learn', reference: 'Reference', remix: 'Remix', watch_again: 'Watch again', share: 'Share', laugh: 'Laugh', other: 'Other' };

export function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } finally { ta.remove(); }
  return Promise.resolve();
}

export function isMac(): boolean { return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform); }

/**
 * Is this a phone or tablet — a device where a Chrome extension cannot be installed at all?
 *
 * Onboarding screen 1 used to offer "Install the Companion" on a phone with no word that a computer is needed, and
 * the day the extension reaches the Chrome Web Store that would have become the *primary* button on a device where
 * the flow cannot be finished. Deliberately conservative: only obvious mobile/tablet user agents and touch-only
 * pointers count, so a desktop is never told it cannot install something it can.
 */
export function isHandheld(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/Android|iPhone|iPod|IEMobile|Opera Mini|Mobile Safari/i.test(ua)) return true;
  // iPadOS reports itself as a Mac; the touch points give it away.
  if (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1) return true;
  if (/iPad|Tablet/i.test(ua)) return true;
  try { return window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 900; } catch { return false; }
}
