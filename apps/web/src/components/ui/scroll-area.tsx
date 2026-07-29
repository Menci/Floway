import { ClickScrollPlugin, OverlayScrollbars } from 'overlayscrollbars';
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { PropsWithChildren } from 'react';
import 'overlayscrollbars/overlayscrollbars.css';

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

const subscribeToScrollbarSize = (listener: () => void) => {
  scrollbarSizeListeners.add(listener);
  ensureScrollbarProbe();
  return () => scrollbarSizeListeners.delete(listener);
};

const getNativeScrollbarSize = () => nativeScrollbarSize;
const getServerScrollbarSize = () => 0;
const nativeViewportQuery = '(max-width: 1200px)';
const subscribeToNativeViewport = (listener: () => void) => {
  const media = window.matchMedia(nativeViewportQuery);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
};
const getNativeViewport = () => window.matchMedia(nativeViewportQuery).matches;
const getServerNativeViewport = () => true;

export const useOverlayScrollbarsEnabled = () => {
  const scrollbarSize = useSyncExternalStore(subscribeToScrollbarSize, getNativeScrollbarSize, getServerScrollbarSize);
  const nativeViewport = useSyncExternalStore(subscribeToNativeViewport, getNativeViewport, getServerNativeViewport);
  return scrollbarSize > 0 && !nativeViewport;
};

const overflowFor = (axes: ScrollAxes) => ({
  x: axes === 'vertical' ? 'hidden' as const : 'scroll' as const,
  y: axes === 'horizontal' ? 'hidden' as const : 'scroll' as const,
});

export const initializeScrollArea = (
  host: HTMLDivElement,
  viewport: HTMLDivElement,
  axes: ScrollAxes,
  noTabIndex: boolean,
  overlayScrollbarsEnabled: boolean,
) => {
  if (!overlayScrollbarsEnabled) return;
  const instance = OverlayScrollbars({ target: host, elements: { viewport } }, {
    overflow: overflowFor(axes),
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
  className = '',
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

  const overflow = overflowFor(axes);
  return (
    <div
      className={`${scrollAreaHostClassName} ${className}`}
      {...(overlayScrollbarsEnabled ? { 'data-overlayscrollbars-initialize': '' } : {})}
      ref={hostRef}
    >
      <div
        className={`h-full w-full ${contentClassName}`}
        ref={viewportRef}
        style={{ overflowX: overflow.x, overflowY: overflow.y }}
      >
        {children}
      </div>
    </div>
  );
});

export const scrollAreaCss = `
  .floway-scroll-area[data-overlayscrollbars='host'] .os-scrollbar {
    --os-handle-bg: rgba(100, 116, 139, 0.32);
    --os-handle-bg-hover: rgba(100, 116, 139, 0.5);
    --os-handle-bg-active: rgba(100, 116, 139, 0.7);
    --os-size: 12px;
  }
  .floway-scroll-area[data-overlayscrollbars='host'] .os-scrollbar-horizontal:not(:hover) .os-scrollbar-handle {
    height: 4px;
  }
  .floway-scroll-area[data-overlayscrollbars='host'] .os-scrollbar-vertical:not(:hover) .os-scrollbar-handle {
    width: 4px;
  }
`;
