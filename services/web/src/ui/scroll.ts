import { useLayoutEffect, useRef, useState } from 'react';

/**
 * A box that scrolls must be reachable by keyboard (WCAG 2.1.1; axe `scrollable-region-focusable`). This says whether
 * the element overflows its own box, so the caller gives it `tabIndex={0}` (and a name) only then: a box that fits
 * adds no tab stop.
 */
export function useScrollable<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setScrolls(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, scrolls };
}
