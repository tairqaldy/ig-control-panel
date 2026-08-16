import { useLayoutEffect, useRef, useState } from 'react';

/** Width of a container element (ResizeObserver) — the SVG charts size to it and keep text un-stretched. */
export function useMeasure<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => { const w = entries[0]?.contentRect.width ?? 0; setWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w)); });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}
