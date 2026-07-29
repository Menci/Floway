import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

// WinUI's NavigationView does not move one indicator between items. It keeps a
// separate indicator per item and, on a selection change, plays a matched pair
// of composition animations: the one losing selection stretches toward the
// destination and fades, the one taking it stretches in from the source. Within
// a single list the two are superimposed and read as one bar, which is why one
// element reproduces them there.
//
// The drawer is two lists, though -- a scrolling body and a pinned footer --
// and a selection that crosses between them has no single element that can span
// both. Each list owns an indicator, and on a crossing the pair plays for real:
// the leaving list runs the outgoing half, the arriving list the incoming half.
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
  // Where the other list sits relative to this one, so a crossing knows which
  // way to reach. Null while the selection is inside this list.
  crossing,
  selectedValue,
}: {
  containerRef: RefObject<HTMLElement | null>;
  inset: number;
  crossing: 'above' | 'below' | null;
  selectedValue: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const previousRef = useRef<Geometry | null>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const item = container?.querySelector<HTMLElement>(`[data-nav-value="${CSS.escape(selectedValue)}"]`);
    // On a crossing the item is in the other list, and the bar has to stay put
    // long enough to play its exit; it is cleared when that finishes.
    if (container && item) setGeometry(geometryOf(container, item));
    else if (!previousRef.current) setGeometry(null);
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

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // A crossing has no measurable gap inside this list, so the reach is the
    // item's own length -- enough to read as travel toward the other list.
    const distance = crossing
      ? (crossing === 'below' ? geometry.height : -geometry.height)
      : geometry.top - previous.top;
    if (distance === 0) return;

    const from = crossing ? 0 : previous.top - geometry.top;
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

    // The outgoing half fades where the incoming half does not. WinUI holds it
    // opaque for the stretch and clears it over the settle.
    if (!crossing) return;
    const exit = bar.animate([
      { opacity: 1, easing: 'steps(1, end)' },
      { opacity: 1, offset: POSITION_SNAP, easing: SETTLE_EASING },
      { opacity: 0 },
    ], { duration: DURATION_MS, fill: 'forwards' });
    exit.finished.then(() => {
      previousRef.current = null;
      setGeometry(null);
    }, () => {});
  }, [crossing, geometry]);

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
