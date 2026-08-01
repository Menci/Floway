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
const scrollbarSizeListeners = new Set<() => void>();

// Whether the platform's scrollbars take layout width, measured rather than
// assumed: a 500px box overflowed by a 1000px child gives the bar's width as
// the difference between its border box and its content box.
//
// The probe is built, read and removed inside one call, leaving nothing behind.
// React renders this app's whole document, so a node parked in `<body>` before
// hydration is a node React did not put there -- it is removed during
// reconciliation, and a detached element measures zero on both boxes. Keeping
// one alive across hydration therefore reported a real width once and zero
// forever after, which reads exactly like the platform having overlay bars.
const measureNativeScrollbarSize = () => {
  if (typeof document === 'undefined' || !document.body) return 0;
  const outer = document.createElement('div');
  outer.setAttribute('aria-hidden', 'true');
  outer.style.cssText = 'position:absolute;top:-9999px;width:500px;height:500px;overflow:auto;';
  const inner = document.createElement('div');
  inner.style.cssText = 'width:1000px;height:1000px;';
  outer.appendChild(inner);
  document.body.appendChild(outer);
  const size = Math.max(outer.offsetWidth - outer.clientWidth, outer.offsetHeight - outer.clientHeight);
  outer.remove();
  return size;
};

const updateNativeScrollbarSize = () => {
  const next = measureNativeScrollbarSize();
  if (next === nativeScrollbarSize) return;
  nativeScrollbarSize = next;
  scrollbarSizeListeners.forEach(listener => listener());
};

// The setting is a system one and can change under a running page. Nothing
// fires on the change itself, so it is re-read at the moments the answer could
// have changed while the page was not looking.
if (typeof document !== 'undefined') {
  const measureNow = () => updateNativeScrollbarSize();
  if (document.body) measureNow();
  else document.addEventListener('DOMContentLoaded', measureNow, { once: true });
  window.addEventListener('resize', measureNow);
  window.addEventListener('focus', measureNow);
  document.addEventListener('visibilitychange', measureNow);
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
