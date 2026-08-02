import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { prefersReducedMotion } from '../../lib/reduced-motion';
import { INDICATOR_DURATION_MS, INDICATOR_POSITION_SNAP, INDICATOR_SETTLE_EASING, INDICATOR_STRETCH_EASING } from '../../winui/motion';

// WinUI's NavigationView does not move one indicator between items. It keeps a
// separate indicator per item and, on a selection change, plays a matched pair
// of composition animations. Both halves run the same offset, scale and anchor
// keyframes over the same 600ms, each against its own item, so the pair draws
// one rectangle twice; the only thing the outgoing half adds is an opacity that
// holds through the first third and falls away over the rest. Within a single
// list the two are superimposed and the opaque incoming half covers the fading
// outgoing one, which is why one element reproduces them there.
//
// The drawer is two lists, though -- a scrolling body and a pinned footer --
// and each indicator is clipped to its own item, so neither half can draw where
// the other one is. Each list plays its half on its own item over the same
// 600ms, starting together. The list losing the selection stretches toward the
// list taking it, settles back to its resting length and fades away across that
// settle. The list taking it holds its bar invisible for as long as the offset
// leg would have it drawn in the other list, then shows it at the snap already
// extended toward where the selection came from and lets it contract. Within
// one list superimposition is what hides the outgoing half; across two it is
// the fade.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.cpp#L2176-L2233
//
// The offset, the scale and the anchor change are three animations on nested
// elements, because they carry different easings and only a nested element can
// give two transforms their own timing. The anchor change is a transform and
// not a transform-origin: a transform-origin animation cannot run on the
// compositor, so it advances only when the main thread does, while the two
// transforms advance without it -- and the instant all three are written to
// step at is the snap, which is where a route commit lands. Measured with the
// main thread held across the snap, the bar was drawn anchored at the edge it
// was leaving for as long as the main thread was behind, off by its own inset,
// in both engines. So the track steps the offset and clips the bar to the item,
// and a nested element carries the mirror of that step: zero through the first
// third, the offset the track has just given up at the snap, and back to zero
// over the settle. The two steps cancel frame for frame, which holds the bar at
// the edge it has reached without its origin moving, and leaves every leg of
// the move a composited transform.

// The bar's width and corner radius are stated outright. Its length is not:
// WinUI states a fixed 16px against a 36px item, and the operator asked that
// this indicator be derived from the row height by a formula that hardcodes
// nothing and reproduces the stock length at the stock row height. A quarter
// inset at each end is that formula, and 20px is the length he pinned for this
// sidebar. A margin percentage resolves against the containing block's
// inline size rather than its block size, so the inset is computed from the
// item box this component has already measured.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L217
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L220-L222
const INDICATOR_INSET_RATIO = 0.25;
const INDICATOR_WIDTH = 3;
const INDICATOR_RADIUS = 2;

interface Geometry { top: number; left: number; width: number; height: number }

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
  const anchorRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const previousRef = useRef<Geometry | null>(null);
  const ranFor = useRef<string | undefined>(undefined);
  const handedOver = useRef(false);
  const [geometry, setGeometry] = useState<Geometry | null>(null);

  useLayoutEffect(() => {
    // A bar with no position in this list to travel from was either handed over
    // by the other list or is the first one this list has drawn, and only the
    // hand-over animates. So the question is whether the selection MOVED,
    // rather than whether this list held it before -- which is also true on a
    // fresh load, where nobody handed anything over and WinUI plays nothing for
    // an initial selection. Running again on the same selection is not a move
    // either, which is what a StrictMode double pass is.
    //
    // Every commit records the selection it saw, whether or not this list holds
    // it. A list only ever takes a hand-over on a commit that did not find it
    // holding the selection before -- so recording only the selections a list
    // holds is recording exactly the commits that cannot ask the question. The
    // footer holds one item and would never have recorded anything else.
    handedOver.current = ranFor.current !== undefined && ranFor.current !== selectedValue;
    ranFor.current = selectedValue;
    const container = containerRef.current;
    const item = container?.querySelector<HTMLElement>(`[data-nav-value="${CSS.escape(selectedValue)}"]`);
    // A bar that has to leave is not cleared here; the effect below plays it
    // out first.
    if (!container || !item) return;
    setGeometry(geometryOf(container, item));
  }, [containerRef, selectedValue]);

  // Leaving for the other list, which is WinUI's outgoing half on this list's
  // own item. Its offset leg is the one that cannot be taken literally: it
  // carries the bar to an item in the other list, and this bar is clipped to
  // the item it sits in. So the stretch reaches by the item's own length, the
  // clip takes the rest, and the settle brings the bar back to its resting
  // length in the item it is leaving rather than in the one it cannot reach.
  useEffect(() => {
    const container = containerRef.current;
    if (!geometry || container?.querySelector(`[data-nav-value="${CSS.escape(selectedValue)}"]`)) return;
    const bar = barRef.current;
    if (!bar) return;
    const drop = () => {
      previousRef.current = null;
      setGeometry(null);
    };
    // Nothing to wait out when nothing is playing.
    if (prefersReducedMotion()) {
      drop();
      return;
    }
    bar.style.transformOrigin = otherListIs === 'below' ? 'top' : 'bottom';
    // The bar goes when the animation says so, not when a timer of the same
    // length does: the timer starts at the call and the animation starts at the
    // next frame, so the frames a timer cuts off are the ones the fade ends on.
    const leave = bar.animate([
      { opacity: 1, transform: 'scaleY(1)', easing: INDICATOR_STRETCH_EASING },
      { opacity: 1, transform: `scaleY(${geometry.height / bar.offsetHeight + 1})`, offset: INDICATOR_POSITION_SNAP, easing: INDICATOR_SETTLE_EASING },
      { opacity: 0, transform: 'scaleY(1)' },
    ], { duration: INDICATOR_DURATION_MS, fill: 'forwards' });
    leave.addEventListener('finish', drop);
    return () => leave.cancel();
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
    const anchor = anchorRef.current;
    const bar = barRef.current;
    const previous = previousRef.current;
    previousRef.current = geometry;
    if (!track || !anchor || !bar || !geometry) return;
    if (prefersReducedMotion()) return;
    if (!previous && !handedOver.current) return;

    // Taking the hand-over: there is no position in this list to travel from,
    // so the reach is the item's own length toward where the selection came
    // from.
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
    // The bar grows out of what it is leaving, so it is anchored at the edge
    // facing there -- and stays anchored there for the whole move. What changes
    // is the offset underneath it.
    bar.style.transformOrigin = distance > 0 ? 'top' : 'bottom';

    if (!previous) {
      bar.animate([
        { opacity: 0, transform: 'scaleY(1)', easing: 'steps(1, end)' },
        { opacity: 1, transform: `scaleY(${peak})`, offset: INDICATOR_POSITION_SNAP, easing: INDICATOR_SETTLE_EASING },
        { opacity: 1, transform: 'scaleY(1)' },
      ], { duration: INDICATOR_DURATION_MS });
      return;
    }

    const travelled = `translateY(${previous.top - geometry.top}px)`;
    track.animate([
      { transform: travelled, easing: 'steps(1, end)' },
      { transform: 'translateY(0px)', offset: INDICATOR_POSITION_SNAP },
      { transform: 'translateY(0px)' },
    ], { duration: INDICATOR_DURATION_MS });

    anchor.animate([
      { transform: 'translateY(0px)', easing: 'steps(1, end)' },
      { transform: travelled, offset: INDICATOR_POSITION_SNAP, easing: INDICATOR_SETTLE_EASING },
      { transform: 'translateY(0px)' },
    ], { duration: INDICATOR_DURATION_MS });

    bar.animate([
      { transform: 'scaleY(1)', easing: INDICATOR_STRETCH_EASING },
      { transform: `scaleY(${peak})`, offset: INDICATOR_POSITION_SNAP, easing: INDICATOR_SETTLE_EASING },
      { transform: 'scaleY(1)' },
    ], { duration: INDICATOR_DURATION_MS });
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
    <div ref={anchorRef} style={{ display: 'flex' }}>
      <div
        ref={barRef}
        style={{
          backgroundColor: 'var(--winui-accent-fill-default)',
          borderRadius: INDICATOR_RADIUS,
          marginBlock: geometry.height * INDICATOR_INSET_RATIO,
          marginInlineStart: inset,
          width: INDICATOR_WIDTH,
        }}
      />
    </div>
  </div>;
}
