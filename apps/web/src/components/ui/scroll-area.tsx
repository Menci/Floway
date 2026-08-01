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

const updateNativeScrollbarSize = () => {
  if (!scrollbarProbe) return;
  const next = Math.max(
    scrollbarProbe.offsetWidth - scrollbarProbe.clientWidth,
    scrollbarProbe.offsetHeight - scrollbarProbe.clientHeight,
  );
  if (next === nativeScrollbarSize) return;
  nativeScrollbarSize = next;
  scrollbarSizeListeners.forEach(listener => listener());
};

const ensureScrollbarProbe = () => {
  if (scrollbarProbe || typeof document === 'undefined') return;
  const outer = document.createElement('div');
  outer.setAttribute('aria-hidden', 'true');
  outer.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:500px;height:500px;overflow:scroll;pointer-events:none;visibility:hidden;';
  const inner = document.createElement('div');
  inner.style.cssText = 'width:1000px;height:1000px;';
  outer.appendChild(inner);
  document.body.appendChild(outer);
  scrollbarProbe = outer;
  new ResizeObserver(updateNativeScrollbarSize).observe(outer);
  window.addEventListener('resize', updateNativeScrollbarSize);
  updateNativeScrollbarSize();
};

// The first ScrollArea must know whether native scrollbars consume layout
// space before React renders it. Module scripts run after the document is
// parsed, so this normally measures synchronously; the listener only covers
// non-browser tooling that imports the module unusually early.
if (typeof document !== 'undefined') {
  if (document.body) ensureScrollbarProbe();
  else document.addEventListener('DOMContentLoaded', ensureScrollbarProbe, { once: true });
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
