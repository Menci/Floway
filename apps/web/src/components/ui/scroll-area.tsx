import { ClickScrollPlugin, OverlayScrollbars } from 'overlayscrollbars';
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { PropsWithChildren } from 'react';
import 'overlayscrollbars/overlayscrollbars.css';

import { fluentComponents } from '../../fluent';

const { mergeClasses } = fluentComponents;

OverlayScrollbars.plugin(ClickScrollPlugin);

export type ScrollAxes = 'both' | 'horizontal' | 'vertical';
const SCROLL_AREA_HOST_CLASS = 'floway-scroll-area relative overflow-hidden';

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

const useOverlayScrollbarsEnabled = (): boolean => useSyncExternalStore(
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

const initializeScrollArea = (
  host: HTMLElement,
  viewport: HTMLElement,
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

interface ScrollAreaHost {
  axes: ScrollAxes;
  noTabIndex?: boolean;
  /**
   * A host whose scrollport is built by something else -- a virtualised list
   * owning its own element -- hands it over here instead of taking
   * `viewportRef`, so the wiring waits for the element the same way.
   */
  viewport?: HTMLElement | null;
}

/**
 * The whole recipe a scroll area host needs: the two elements, the props that
 * mark the host, the scrollport's own overflow, and the library binding
 * between them. `ScrollArea` is this hook over a plain div; a host that has to
 * be some other element calls the hook directly.
 */
export const useScrollAreaHost = ({ axes, noTabIndex = false, viewport }: ScrollAreaHost) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const overlayScrollbarsEnabled = useOverlayScrollbarsEnabled();

  useLayoutEffect(() => {
    const host = hostRef.current;
    const scrollport = viewport === undefined ? viewportRef.current : viewport;
    if (!host || !scrollport) return;
    return initializeScrollArea(host, scrollport, axes, noTabIndex, overlayScrollbarsEnabled);
  }, [axes, noTabIndex, overlayScrollbarsEnabled, viewport]);

  const overflow = elementOverflowFor(axes, overlayScrollbarsEnabled);
  return {
    hostProps: {
      className: SCROLL_AREA_HOST_CLASS,
      ...(overlayScrollbarsEnabled ? { 'data-overlayscrollbars-initialize': '' } : {}),
      ref: hostRef,
    },
    viewportRef,
    viewportStyle: { overflowX: overflow.x, overflowY: overflow.y },
  };
};

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea({
  axes,
  children,
  className,
  contentClassName = '',
  noTabIndex = false,
  viewportClassName,
}, forwardedRef) {
  const { hostProps, viewportRef, viewportStyle } = useScrollAreaHost({ axes, noTabIndex });
  useImperativeHandle(forwardedRef, () => viewportRef.current as HTMLDivElement, [viewportRef]);

  return (
    <div {...hostProps} className={mergeClasses(hostProps.className, className)}>
      <div
        className={mergeClasses('h-full w-full', viewportClassName)}
        ref={viewportRef}
        style={viewportStyle}
      >
        <div className={contentClassName}>{children}</div>
      </div>
    </div>
  );
});
