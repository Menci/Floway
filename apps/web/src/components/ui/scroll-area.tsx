import { ClickScrollPlugin, OverlayScrollbars } from 'overlayscrollbars';
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { PropsWithChildren } from 'react';
import 'overlayscrollbars/overlayscrollbars.css';

import { fluentComponents } from '../../fluent';

const { mergeClasses } = fluentComponents;

OverlayScrollbars.plugin(ClickScrollPlugin);

export type ScrollAxes = 'both' | 'horizontal' | 'vertical';
export const scrollAreaHostClassName = 'floway-scroll-area relative overflow-hidden';

interface ScrollAreaProps extends PropsWithChildren {
  axes: ScrollAxes;
  className?: string;
  contentClassName?: string;
  noTabIndex?: boolean;
}

let nativeScrollbarSize = 0;
let scrollbarProbe: HTMLDivElement | null = null;
const scrollbarSizeListeners = new Set<() => void>();

// Whether the platform's scrollbars take layout width, measured rather than
// assumed: a 500px box overflowed by a 1000px child gives the bar's width as
// the difference between its border box and its content box.
//
// The probe is parked off-page rather than hidden, because a box that is not
// painted is a poor place to read a painted scrollbar's width from. It stays in
// the document so a ResizeObserver can watch it: the answer changes under a
// running page -- a system setting, or DevTools switching between a desktop and
// a device viewport -- and not every such change resizes the window, so the
// element itself is the only reliable signal.
//
// It is re-attached if it ever loses the document. React renders this app's
// whole document, so anything parked in `<body>` is living in a tree React
// reconciles; a detached element reports the same width for both boxes, which
// is indistinguishable from a platform with overlay bars and would silently
// disable the library everywhere.
const ensureScrollbarProbe = () => {
  if (typeof document === 'undefined' || !document.body) return null;
  if (scrollbarProbe?.isConnected) return scrollbarProbe;
  if (scrollbarProbe) {
    document.body.appendChild(scrollbarProbe);
    return scrollbarProbe;
  }
  const outer = document.createElement('div');
  outer.setAttribute('aria-hidden', 'true');
  outer.style.cssText = 'position:absolute;top:-9999px;width:500px;height:500px;overflow:auto;';
  const inner = document.createElement('div');
  inner.style.cssText = 'width:1000px;height:1000px;';
  outer.appendChild(inner);
  document.body.appendChild(outer);
  scrollbarProbe = outer;
  new ResizeObserver(updateNativeScrollbarSize).observe(outer);
  window.addEventListener('resize', updateNativeScrollbarSize);
  return outer;
};

function updateNativeScrollbarSize() {
  const probe = ensureScrollbarProbe();
  if (!probe) return;
  const next = Math.max(probe.offsetWidth - probe.clientWidth, probe.offsetHeight - probe.clientHeight);
  if (next === nativeScrollbarSize) return;
  nativeScrollbarSize = next;
  scrollbarSizeListeners.forEach(listener => listener());
}

// The first ScrollArea must know the answer before React renders it. Module
// scripts run after the document is parsed, so this normally measures
// synchronously; the listener only covers tooling that imports the module
// earlier than a browser would.
if (typeof document !== 'undefined') {
  if (document.body) updateNativeScrollbarSize();
  else document.addEventListener('DOMContentLoaded', updateNativeScrollbarSize, { once: true });
}

const subscribeToScrollbarSize = (listener: () => void) => {
  scrollbarSizeListeners.add(listener);
  return () => scrollbarSizeListeners.delete(listener);
};

const getNativeScrollbarSize = () => nativeScrollbarSize;
const getServerScrollbarSize = () => 0;

export const useOverlayScrollbarsEnabled = (): boolean => useSyncExternalStore(
  subscribeToScrollbarSize,
  getNativeScrollbarSize,
  getServerScrollbarSize,
) > 0;

// What the library is asked to take over. Its vocabulary is its own -- there is
// no `auto` in it -- and `scroll` here means "this axis is mine", not "reserve a
// bar".
const libraryOverflowFor = (axes: ScrollAxes) => ({
  x: axes === 'vertical' ? 'hidden' as const : 'scroll' as const,
  y: axes === 'horizontal' ? 'hidden' as const : 'scroll' as const,
});

// What the element itself carries, inline, from the first render. `scroll`
// reserves the bar's width whether or not there is anything to scroll, so on a
// platform whose bars take layout width it is a permanent strip of missing
// content -- and the element carries this before the library has initialised,
// so writing it unconditionally hands every scroller a native bar for that
// window. Native scrolling asks for `auto`; the library's own path keeps
// `scroll`, which is what it reads the axis from.
const elementOverflowFor = (axes: ScrollAxes, overlayScrollbarsEnabled: boolean) => {
  const scrollable = overlayScrollbarsEnabled ? 'scroll' as const : 'auto' as const;
  return {
    x: axes === 'vertical' ? 'hidden' as const : scrollable,
    y: axes === 'horizontal' ? 'hidden' as const : scrollable,
  };
};

export const initializeScrollArea = (
  host: HTMLDivElement,
  viewport: HTMLDivElement,
  axes: ScrollAxes,
  noTabIndex: boolean,
  overlayScrollbarsEnabled: boolean,
) => {
  if (!overlayScrollbarsEnabled) return;
  const instance = OverlayScrollbars({ target: host, elements: { viewport } }, {
    overflow: libraryOverflowFor(axes),
    scrollbars: {
      autoHide: 'leave',
      autoHideSuspend: true,
      clickScroll: true,
    },
  }, {
    initialized(current) {
      if (noTabIndex) current.elements().viewport.removeAttribute('tabindex');
    },
  });
  return () => instance.destroy();
};

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea({
  axes,
  children,
  className,
  contentClassName = '',
  noTabIndex = false,
}, forwardedRef) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const overlayScrollbarsEnabled = useOverlayScrollbarsEnabled();
  useImperativeHandle(forwardedRef, () => viewportRef.current as HTMLDivElement, []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const viewport = viewportRef.current;
    if (!host || !viewport) return;
    return initializeScrollArea(host, viewport, axes, noTabIndex, overlayScrollbarsEnabled);
  }, [axes, noTabIndex, overlayScrollbarsEnabled]);

  const overflow = elementOverflowFor(axes, overlayScrollbarsEnabled);
  return (
    <div
      className={mergeClasses(scrollAreaHostClassName, className)}
      {...(overlayScrollbarsEnabled ? { 'data-overlayscrollbars-initialize': '' } : {})}
      ref={hostRef}
    >
      <div
        className="h-full w-full"
        ref={viewportRef}
        style={{ overflowX: overflow.x, overflowY: overflow.y }}
      >
        <div className={contentClassName}>{children}</div>
      </div>
    </div>
  );
});
