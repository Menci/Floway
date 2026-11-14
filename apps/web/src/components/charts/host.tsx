import { useState, type MouseEventHandler, type ReactNode } from 'react';

import { chartHeight } from './layout';
import { useElementSize, type ElementSize } from './use-element-size';
import { EmptyStateLine } from '../ui/empty-state';

const narrowChartWidth = 120;

// The box every dashboard chart is drawn into: it reserves the height, measures
// the width each plot needs, and answers a container too narrow to plot in
// and a range with nothing in it, so a chart module supplies only its plot.
export function ChartHost({ children, className, emptyText, hasData, onMouseEnter, onMouseLeave, onMouseMove }: {
  children: (frame: { element: HTMLDivElement; size: ElementSize }) => ReactNode;
  className: string;
  emptyText: string;
  hasData: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onMouseMove?: MouseEventHandler<HTMLDivElement>;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const size = useElementSize(element);

  return (
    <div className={`${className} relative min-w-0 w-full`} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onMouseMove={onMouseMove} ref={setElement} style={{ height: chartHeight }}>
      {element === null || size.width < narrowChartWidth ? null
        : hasData ? children({ element, size })
          : <div className="grid h-full place-items-center"><EmptyStateLine>{emptyText}</EmptyStateLine></div>}
    </div>
  );
}
