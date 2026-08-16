/* Small hooks shared by the landing vignettes. */
import { useEffect, useState } from 'react';

/** Fetch a static JSON file from web/public/landing/. `null` while loading, `fallback` on 404 so sections can hide themselves. */
export function useLandingJson<T>(url: string, fallback: T): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => { if (alive) setData(j as T); })
      .catch(() => { if (alive) setData(fallback); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return data;
}

/**
 * A looping clock for the vignettes: elapsed ms in [0, duration), ticking while `active`; when `reduced` it sits at the
 * end state (duration - 1) so reduced-motion users see the finished picture, not a frozen first frame.
 */
export function useTimeline(active: boolean, duration: number, opts: { reduced?: boolean; tick?: number; loop?: boolean } = {}): number {
  const { reduced = false, tick = 40, loop = true } = opts;
  const [t, setT] = useState(0);
  useEffect(() => {
    if (reduced) { setT(duration - 1); return; }
    if (!active) { setT(0); return; }
    const t0 = performance.now();
    const iv = setInterval(() => {
      const e = performance.now() - t0;
      if (!loop && e >= duration) { setT(duration - 1); clearInterval(iv); return; }
      setT(e % duration);
    }, tick);
    return () => clearInterval(iv);
  }, [active, duration, reduced, tick, loop]);
  return t;
}

/** Characters of `text` visible at time `t` for a typing run that starts at `from` and types `cps` chars/second. */
export function typed(text: string, t: number, from: number, cps = 34): string {
  if (t < from) return '';
  return text.slice(0, Math.min(text.length, Math.floor(((t - from) / 1000) * cps)));
}
/** Words of `text` visible at time `t` for a "streaming" run (LLM-style, a few words per tick). */
export function streamed(text: string, t: number, from: number, wps = 14): string {
  if (t < from) return '';
  const words = text.split(' ');
  const n = Math.min(words.length, Math.floor(((t - from) / 1000) * wps));
  return words.slice(0, n).join(' ');
}
