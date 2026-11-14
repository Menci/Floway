import { useLayoutEffect, useRef, type ReactNode } from 'react';

import { chartCalloutSurfaceStyle } from './frame-styles';
import type { ChartHoverPointerStore } from './linked-hover';

export interface ChartCalloutTarget { getBoundingClientRect: () => DOMRect }

export function ChartCalloutPopover({ children, pointerStore, target }: { children: ReactNode; pointerStore: ChartHoverPointerStore; target: ChartCalloutTarget }) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    let frame: number | null = null;
    const position = () => {
      const surface = surfaceRef.current;
      if (surface === null) return;
      const point = target.getBoundingClientRect();
      const gap = 20;
      const inset = 8;
      const width = surface.offsetWidth;
      const height = surface.offsetHeight;
      const x = Math.max(inset, Math.min(point.x + (point.x + gap + width <= window.innerWidth - inset ? gap : -gap - width), window.innerWidth - inset - width));
      const y = Math.max(inset, Math.min(point.y + (point.y + gap + height <= window.innerHeight - inset ? gap : -gap - height), window.innerHeight - inset - height));
      const containingRect = surface.offsetParent?.getBoundingClientRect() ?? new DOMRect();
      surface.style.transform = `translate3d(${x - containingRect.left}px, ${y - containingRect.top}px, 0)`;
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        position();
      });
    };
    const unsubscribe = pointerStore.subscribe(schedule);
    const resizeObserver = new ResizeObserver(schedule);
    if (surfaceRef.current !== null) resizeObserver.observe(surfaceRef.current);
    position();
    return () => {
      unsubscribe();
      resizeObserver.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [pointerStore, target]);
  return <div aria-live="polite" ref={surfaceRef} role="status" style={{ ...chartCalloutSurfaceStyle, left: 0, position: 'absolute', top: 0, zIndex: 1 }}>{children}</div>;
}
