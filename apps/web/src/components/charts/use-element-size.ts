import { useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

// The element arrives as a ref rather than as state, and that is what keeps the
// chart out of the first painted frame's way. Held in state, the box is null on
// the first render, so the measurement cannot happen until a ref callback has
// put it there and the component has rendered again -- three renders before the
// chart has a width. React flushes an update from a layout effect before the
// browser paints, but it is free to paint between the commits either side of
// that state hop, and on a reload it does: hydration runs inside a transition,
// so the page appeared with a chart-shaped hole in it for about four frames. A
// ref is already attached when the layout effect below runs, so the
// measurement lands in the first commit and the chart is in the first frame.
export const useElementSize = (ref: RefObject<HTMLElement | null>): ElementSize => {
  const [size, setSize] = useState({ width: 0, height: 320 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setSize({
        width: Math.max(0, Math.floor(rect.width)),
        height: Math.max(260, Math.floor(rect.height)),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
};
