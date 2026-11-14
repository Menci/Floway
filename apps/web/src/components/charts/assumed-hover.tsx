import type { ReactNode } from 'react';

import { ChartCalloutPopover } from './callout-popover';
import { chartPointerOffset, type ChartHoverPointerStore } from './linked-hover';

// The cursor line states where the other chart is hovering, so it stands on its
// own wherever that position lands in this plot. The popover is the part that
// can have nothing to say -- a point the dataset has no reading for -- and it is
// left off then, matching a native hover, which keeps its vertical line and lets
// the frame's own rule hide the empty callout.
export function AssumedChartHover({ bottom, children, element, pointerStore, top, x }: {
  bottom: number;
  children?: ReactNode;
  element: HTMLElement;
  pointerStore: ChartHoverPointerStore;
  top: number;
  x: number;
}) {
  const target = {
    getBoundingClientRect: () => {
      const rect = element.getBoundingClientRect();
      const pointer = pointerStore.getSnapshot();
      const offset = pointer === null ? null : chartPointerOffset(pointer, rect);
      return new DOMRect(
        rect.left + (offset?.x ?? x),
        rect.top + (offset?.y ?? top + (rect.height - top - bottom) / 2),
        0,
        0,
      );
    },
  };
  return <>
    <div
      aria-hidden="true"
      className="absolute pointer-events-none border-0 border-l border-dashed border-fui-divider"
      data-chart-assumed-hover-cursor=""
      style={{ bottom, left: x, top }}
    />
    {children == null ? null : <ChartCalloutPopover pointerStore={pointerStore} target={target}>{children}</ChartCalloutPopover>}
  </>;
}
