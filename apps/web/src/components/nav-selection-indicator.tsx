import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

// WinUI's NavigationView does not move one indicator between items. It keeps a
// separate indicator per item and, on a selection change, plays a matched pair
// of composition animations that overlap so precisely that they read as a
// single bar stretching from the old item to the new one. Reproducing them on
// one element is faithful and much simpler: the pair only ever differs by the
// outgoing indicator's fade, which is invisible while the two are superimposed.
//
// The offset and the scale are separate animations there and stay separate
// here, because they carry different easings and only a nested element can give
// two transforms their own timing.
//
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.cpp#L2176-L2233
const DURATION_MS = 600;
const POSITION_SNAP = 0.333;
const STRETCH_EASING = 'cubic-bezier(0.9, 0.1, 1, 0.2)';
const SETTLE_EASING = 'cubic-bezier(0.1, 0.9, 0.2, 1)';

// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L220-L222
const INDICATOR_HEIGHT = 16;
const INDICATOR_WIDTH = 3;
const INDICATOR_RADIUS = 2;

type Geometry = { top: number; left: number; height: number };

const geometryOf = (container: HTMLElement, item: HTMLElement): Geometry => {
  const containerBox = container.getBoundingClientRect();
  const itemBox = item.getBoundingClientRect();
  return {
    // The clip box is the item, so the pill can stretch without ever painting
    // outside the fill the item already occupies. WinUI centres the pill in the
    // item rather than pinning it to a fixed inset.
    top: itemBox.top - containerBox.top + container.scrollTop,
    left: itemBox.left - containerBox.left + container.scrollLeft,
    height: itemBox.height,
  };
};

export function NavSelectionIndicator({
  containerRef,
  inset,
  selectedValue,
}: {
  containerRef: RefObject<HTMLElement | null>;
  inset: number;
  selectedValue: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const previousRef = useRef<Geometry | null>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const item = container?.querySelector<HTMLElement>(`[data-nav-value="${CSS.escape(selectedValue)}"]`);
    setGeometry(container && item ? geometryOf(container, item) : null);
  }, [containerRef, selectedValue]);

  // The item can move without the selection changing -- a group appearing above
  // it, the drawer resizing, the list scrolling under a sticky footer. Tracking
  // the container keeps the pill on its item without animating, since nothing
  // was selected.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const item = container.querySelector<HTMLElement>(`[data-nav-value="${CSS.escape(selectedValue)}"]`);
      if (!item) return;
      const next = geometryOf(container, item);
      previousRef.current = next;
      setGeometry(next);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, selectedValue]);

  useEffect(() => {
    const track = trackRef.current;
    const bar = barRef.current;
    const previous = previousRef.current;
    previousRef.current = geometry;
    if (!track || !bar || !geometry || !previous) return;

    const distance = geometry.top - previous.top;
    if (distance === 0) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const from = previous.top - geometry.top;
    // The indicator stretches far enough to span the gap it is crossing, then
    // settles back to its own height.
    const peak = Math.abs(distance) / INDICATOR_HEIGHT + 1;

    track.animate([
      { transform: `translateY(${from}px)`, easing: 'steps(1, end)' },
      { transform: 'translateY(0px)', offset: POSITION_SNAP },
      { transform: 'translateY(0px)' },
    ], { duration: DURATION_MS });

    bar.animate([
      { transform: 'scaleY(1)', easing: STRETCH_EASING },
      { transform: `scaleY(${peak})`, offset: POSITION_SNAP, easing: SETTLE_EASING },
      { transform: 'scaleY(1)' },
    ], {
      duration: DURATION_MS,
      // The stretch grows from the edge facing the destination, so the bar
      // reaches toward the item it is travelling to rather than away from it.
      composite: 'replace',
    });
    bar.style.transformOrigin = distance > 0 ? 'top' : 'bottom';
  }, [geometry]);

  if (!geometry) return null;

  return <div
    aria-hidden
    ref={trackRef}
    style={{
      alignItems: 'center',
      display: 'flex',
      height: geometry.height,
      left: geometry.left + inset,
      overflow: 'hidden',
      pointerEvents: 'none',
      position: 'absolute',
      top: geometry.top,
      width: INDICATOR_WIDTH,
    }}
  >
    <div
      ref={barRef}
      style={{
        backgroundColor: 'var(--winui-accent-fill-default)',
        borderRadius: INDICATOR_RADIUS,
        height: INDICATOR_HEIGHT,
        width: '100%',
      }}
    />
  </div>;
}
