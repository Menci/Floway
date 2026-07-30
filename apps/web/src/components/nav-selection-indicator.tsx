import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { DURATION_MS, POSITION_SNAP, REACH_MS, SETTLE_EASING, SETTLE_MS, STRETCH_EASING } from '../lib/winui-motion';

// WinUI's NavigationView does not move one indicator between items. It keeps a
// separate indicator per item and, on a selection change, plays a matched pair
// of composition animations: the one losing selection stretches toward the
// destination and fades, the one taking it stretches in from the source. Within
// a single list the two are superimposed and read as one bar, which is why one
// element reproduces them there.
//
// The drawer is two lists, though -- a scrolling body and a pinned footer --
// and a selection crossing between them has no single element that can span
// both. Playing WinUI's pair there puts one bar in each list and shows them
// moving at once, which reads as two things rather than one. The two halves are
// sequenced instead, and between them they run exactly the
// animation a move within one list runs. The list losing the selection reaches
// its bar out toward the other one for as long as a move spends reaching, then
// drops it; the list taking the selection waits that out and settles a bar in
// from the edge facing where the selection came from, for as long as a move
// spends settling. Played together instead they land in the same instant and
// read as one switch rather than as a handover.
//
// Only the settle, not the stretch before it. The stretch exists to cross the
// gap between two items, and a crossing has no gap to cross inside either list;
// starting the arriving bar already extended toward where the selection came
// from, and letting it contract, is that same animation with the phase it has
// no distance for left out.
//
// The offset and the scale are separate animations there and stay separate
// here, because they carry different easings and only a nested element can give
// two transforms their own timing.
//
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.cpp#L2176-L2233

// The bar's width and corner radius are stated outright. Its 16px length is
// stated against a 36px item, so it is carried here as the inset it leaves at
// each end rather than as a length, and the bar spans whatever room its item
// gives it -- the same way every other selection indicator in the dashboard is
// described. See the list row's in ../winui/controls/list.css.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L217
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L220-L222
const INDICATOR_INSET = 10;
const INDICATOR_WIDTH = 3;
const INDICATOR_RADIUS = 2;

type Geometry = { top: number; left: number; width: number; height: number };

const geometryOf = (container: HTMLElement, item: HTMLElement): Geometry => {
  const containerBox = container.getBoundingClientRect();
  const itemBox = item.getBoundingClientRect();
  return {
    // The clip box is the item, so the pill can stretch without ever painting
    // outside the fill the item already occupies, and so the inset that gives
    // the pill its length is measured against the item's own box.
    top: itemBox.top - containerBox.top + container.scrollTop,
    left: itemBox.left - containerBox.left + container.scrollLeft,
    width: itemBox.width,
    height: itemBox.height,
  };
};

export function NavSelectionIndicator({
  containerRef,
  inset,
  otherListIs,
  selectedValue,
}: {
  containerRef: RefObject<HTMLElement | null>;
  inset: number;
  // Where the other list sits. Fixed per instance, and only read when the
  // selection arrives from there.
  otherListIs: 'above' | 'below';
  selectedValue: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const previousRef = useRef<Geometry | null>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const item = container?.querySelector<HTMLElement>(`[data-nav-value="${CSS.escape(selectedValue)}"]`);
    // A bar that has to leave is not cleared here; the effect below reaches it
    // out first.
    if (!container || !item) return;
    const next = geometryOf(container, item);
    // Arriving from the other list, which is reaching its own bar out in this
    // same commit. Waiting that out is what separates the two.
    if (previousRef.current) {
      setGeometry(next);
      return;
    }
    const handover = window.setTimeout(() => setGeometry(next), REACH_MS);
    return () => window.clearTimeout(handover);
  }, [containerRef, selectedValue]);

  // Leaving for the other list. The bar stays long enough to reach after the
  // selection before it goes, which is the half of WinUI's pair that plays on
  // this side.
  useEffect(() => {
    const container = containerRef.current;
    if (!geometry || container?.querySelector(`[data-nav-value="${CSS.escape(selectedValue)}"]`)) return;
    const bar = barRef.current;
    if (bar && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      bar.style.transformOrigin = otherListIs === 'below' ? 'top' : 'bottom';
      bar.animate(
        [{ transform: 'scaleY(1)' }, { transform: `scaleY(${geometry.height / bar.offsetHeight + 1})` }],
        { duration: REACH_MS, easing: STRETCH_EASING, fill: 'forwards' },
      );
    }
    const gone = window.setTimeout(() => {
      previousRef.current = null;
      setGeometry(null);
    }, REACH_MS);
    return () => window.clearTimeout(gone);
  }, [containerRef, geometry, otherListIs, selectedValue]);

  // The item can move without the selection changing -- a group appearing above
  // it, the drawer resizing, the list scrolling under a sticky footer. Tracking
  // the container keeps the pill on its item, and writing the new position as
  // the previous one too means the move is taken without animating, since
  // nothing was selected.
  //
  // The selected item is found through the attribute Fluent already marks it
  // with, so this subscription depends on nothing that a selection changes and
  // outlives one. Re-subscribing would re-observe, and re-observing fires the
  // callback at once -- overwriting the position the pill is supposed to travel
  // from, a frame before it travels.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const item = container.querySelector<HTMLElement>('[data-nav-value][aria-current="page"]');
      if (!item) return;
      const next = geometryOf(container, item);
      previousRef.current = next;
      setGeometry(next);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef]);

  useEffect(() => {
    const track = trackRef.current;
    const bar = barRef.current;
    const previous = previousRef.current;
    previousRef.current = geometry;
    if (!track || !bar || !geometry) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // Arriving from the other list: there is no position in this one to travel
    // from, so the reach is the item's own length toward where it came from.
    const distance = previous
      ? geometry.top - previous.top
      : (otherListIs === 'below' ? geometry.height : -geometry.height);
    if (distance === 0) return;

    // The indicator stretches far enough to span the gap it is crossing, then
    // settles back to its own height.
    // Every stretch is a multiple of the bar's own length. That length is the
    // room the item leaves it, which the layout has already worked out, so it
    // is read back off the bar rather than recomputed from the inset.
    const peak = Math.abs(distance) / bar.offsetHeight + 1;

    if (previous) {
      track.animate([
        { transform: `translateY(${previous.top - geometry.top}px)`, easing: 'steps(1, end)' },
        { transform: 'translateY(0px)', offset: POSITION_SNAP },
        { transform: 'translateY(0px)' },
      ], { duration: DURATION_MS });
    }

    bar.animate(previous
      ? [
          { transform: 'scaleY(1)', easing: STRETCH_EASING },
          { transform: `scaleY(${peak})`, offset: POSITION_SNAP, easing: SETTLE_EASING },
          { transform: 'scaleY(1)' },
        ]
      : [
          { transform: `scaleY(${peak})`, easing: SETTLE_EASING },
          { transform: 'scaleY(1)' },
        ],
    { duration: previous ? DURATION_MS : SETTLE_MS });

    // The origin flips at the snap, which is what keeps the bar from
    // overshooting. Anchored at the leading edge it grows out of the item it is
    // leaving; at the snap the anchor moves to the trailing edge, so the bar is
    // held at the item it has reached and contracts back into it.
    const leadingEdge = distance > 0 ? 'top' : 'bottom';
    const trailingEdge = distance > 0 ? 'bottom' : 'top';
    if (previous) {
      bar.animate([
        { transformOrigin: leadingEdge, easing: 'steps(1, end)' },
        { transformOrigin: trailingEdge, offset: POSITION_SNAP },
        { transformOrigin: trailingEdge },
      ], { duration: DURATION_MS });
    }
    bar.style.transformOrigin = previous ? trailingEdge : leadingEdge;
  }, [geometry, otherListIs]);

  if (!geometry) return null;

  return <div
    aria-hidden
    ref={trackRef}
    style={{
      display: 'flex',
      // The clip box is the item itself, corners included. WinUI cuts the
      // indicator against the item's rounded rect, and over the three pixels the
      // bar occupies that boundary is a curve rather than a straight edge, so a
      // box only as wide as the bar cannot stand in for it however it is
      // rounded -- it would round its own corners instead of following the
      // item's.
      borderRadius: 'var(--borderRadiusMedium)',
      height: geometry.height,
      left: geometry.left,
      overflow: 'hidden',
      pointerEvents: 'none',
      position: 'absolute',
      top: geometry.top,
      width: geometry.width,
    }}
  >
    <div
      ref={barRef}
      style={{
        backgroundColor: 'var(--winui-accent-fill-default)',
        borderRadius: INDICATOR_RADIUS,
        marginBlock: INDICATOR_INSET,
        marginInlineStart: inset,
        width: INDICATOR_WIDTH,
      }}
    />
  </div>;
}
