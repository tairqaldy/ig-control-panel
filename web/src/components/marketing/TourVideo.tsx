/* "See it in 40 seconds": the product tour video (web/public/landing/tour.mp4|webm, poster tour-poster.jpg).
   Lighthouse-minded: preload="none", and the poster / <source> tags are only attached once the section is near
   the viewport, so nothing downloads for visitors who never scroll here. Reduced motion → poster + Play button.
   If the files are missing (404) the block falls back to the Overview screenshot (which hides itself if that is missing too). */
import { useEffect, useRef, useState } from 'react';
import { useInView, useReducedMotion } from 'motion/react';
import { Play, Pause } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Frame, SHOTS } from './Frame';

const MP4 = '/landing/tour.mp4', WEBM = '/landing/tour.webm', POSTER = '/landing/tour-poster.jpg';

export function TourVideo({ className }: { className?: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const near = useInView(wrap, { margin: '400px 0px', once: true });
  const visible = useInView(wrap, { amount: 0.4 });
  const reduced = useReducedMotion();
  const [armed, setArmed] = useState(false); // sources attached
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [posterOk, setPosterOk] = useState(true);

  // Attach the sources when the section is near (with reduced motion only after an explicit Play).
  useEffect(() => { if (near && !reduced) setArmed(true); }, [near, reduced]);
  useEffect(() => {
    const v = video.current; if (!v || !armed) return;
    v.load();
    if (!reduced) v.play().catch(() => {});
  }, [armed, reduced]);
  // Pause when scrolled away, resume when back — no reason to decode video nobody sees.
  useEffect(() => {
    const v = video.current; if (!v || !armed || reduced) return;
    if (visible) v.play().catch(() => {}); else v.pause();
  }, [visible, armed, reduced]);
  // The poster is a normal image request; probe it so a 404 does not leave a broken-image icon.
  useEffect(() => { if (!near) return; const im = new Image(); im.onerror = () => setPosterOk(false); im.src = POSTER; }, [near]);

  if (failed) return <Frame src={SHOTS.overview} alt="Resurfly overview page" fallback="placeholder" className={className} />;
  const toggle = () => {
    const v = video.current; if (!v) return;
    if (!armed) { setArmed(true); return; }
    if (v.paused) v.play().catch(() => {}); else v.pause();
  };
  return (
    <div ref={wrap} className={cn('mk-frame group', className)} style={{ aspectRatio: '1280 / 800' }}>
      <video
        ref={video} muted loop playsInline preload="none" autoPlay={armed && !reduced}
        poster={near && posterOk ? POSTER : undefined} width={1280} height={800}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onClick={toggle}
        className="absolute inset-0 h-full w-full object-cover cursor-pointer"
        aria-label="Forty-second tour of Resurfly: import, first notes, a question with citations, the graph, one automation rule"
      >
        {armed && <source src={WEBM} type="video/webm" />}
        {/* the error for "no playable source" lands on the LAST <source>, not on the <video> */}
        {armed && <source src={MP4} type="video/mp4" onError={() => setFailed(true)} />}
      </video>
      {!posterOk && !playing && <div className="absolute inset-0 mk-dark bg-[#131312]" aria-hidden />}
      <button type="button" onClick={toggle} aria-label={playing ? 'Pause the tour' : 'Play the tour'}
        className={cn('absolute left-4 bottom-4 inline-flex items-center gap-2 rounded-full bg-black/55 text-white backdrop-blur px-3.5 py-2 text-[12.5px] font-medium transition-opacity',
          playing ? 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100' : 'opacity-100')}>
        {playing ? <Pause size={13} className="fill-white" /> : <Play size={13} className="fill-white" />}{playing ? 'Pause' : 'Play the tour'} <span className="font-mono text-[10.5px] opacity-70">0:40</span>
      </button>
    </div>
  );
}
