import { ClickScrollPlugin, OverlayScrollbars } from 'overlayscrollbars';
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
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

let nativeScrollbarSize: number | null = null;

const measureNativeScrollbar = () => {
  if (nativeScrollbarSize !== null) return nativeScrollbarSize;
  const outer = document.createElement('div');
  outer.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;';
  const inner = document.createElement('div');
  inner.style.cssText = 'width:200px;height:200px;';
  outer.appendChild(inner);
  document.body.appendChild(outer);
  nativeScrollbarSize = Math.max(
    outer.offsetWidth - outer.clientWidth,
    outer.offsetHeight - outer.clientHeight,
  );
  outer.remove();
  return nativeScrollbarSize;
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
) => {
  if (measureNativeScrollbar() === 0) {
    host.removeAttribute('data-overlayscrollbars-initialize');
    return;
  }
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
  useImperativeHandle(forwardedRef, () => viewportRef.current as HTMLDivElement, []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const viewport = viewportRef.current;
    if (!host || !viewport) return;
    return initializeScrollArea(host, viewport, axes, noTabIndex);
  }, [axes, noTabIndex]);

  const overflow = overflowFor(axes);
  return (
    <div
      className={`${scrollAreaHostClassName} ${className}`}
      data-overlayscrollbars-initialize=""
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
