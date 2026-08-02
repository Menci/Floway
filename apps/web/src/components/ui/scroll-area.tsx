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
  /**
   * Styles the scrollport itself -- the box that clips. Padding on the host is
   * outside the clip, so a shadow, focus ring or outline drawn inside the
   * scroller is cut at the scrollport's edge; padding here keeps the overhang.
   */
  viewportClassName?: string;
}

let nativeScrollbarSize = 0;
let scrollbarProbe: HTMLDivElement | null = null;
const scrollbarSizeListeners = new Set<() => void>();

// The probe is parked off-page rather than hidden, because an unpainted box is
// a poor place to read a painted scrollbar's width from. It stays in the
// document so a ResizeObserver can watch it: the answer changes under a running
// page without necessarily resizing the window.
const ensureScrollbarProbe = () => {
  if (typeof document === 'undefined' || !document.body) return null;
  if (scrollbarProbe) {
    if (!scrollbarProbe.isConnected) {
      throw new Error('The native scrollbar probe left the document. Something is removing nodes from <body>; until it stops, every scroll area reads the platform as having overlay scrollbars.');
    }
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

// The first ScrollArea must know the answer before React renders it; the
// listener only covers tooling that imports the module earlier than a browser
// would.
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

// In the library's vocabulary there is no `auto`, and `scroll` means "this axis
// is mine", not "reserve a bar".
const libraryOverflowFor = (axes: ScrollAxes) => ({
  x: axes === 'vertical' ? 'hidden' as const : 'scroll' as const,
  y: axes === 'horizontal' ? 'hidden' as const : 'scroll' as const,
});

// The element carries this inline from the first render, before the library has
// initialised, so `scroll` unconditionally would hand every native scroller a
// permanent reserved strip for that window.
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
  viewportClassName,
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
        className={mergeClasses('h-full w-full', viewportClassName)}
        ref={viewportRef}
        style={{ overflowX: overflow.x, overflowY: overflow.y }}
      >
        <div className={contentClassName}>{children}</div>
      </div>
    </div>
  );
});
