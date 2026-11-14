import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';

import { chartMargins, chartPlotWidth } from './layout';

// Shares are of the plot rather than of the chart box: every chart reserves the
// same frame, so the same share is the same instant in both.
export interface ChartHoverPointer { xRatio: number; yRatio: number }

export interface ChartHoverPointerStore {
  getSnapshot: () => ChartHoverPointer | null;
  subscribe: (listener: () => void) => () => void;
}

interface LinkedHoverState {
  sourceId: string;
  pointer: ChartHoverPointer;
}

interface LinkedChartHoverStore extends ChartHoverPointerStore {
  getHover: () => LinkedHoverState | null;
  report: (sourceId: string, pointer: ChartHoverPointer | null) => void;
  subscribeHover: (listener: () => void) => () => void;
}

export interface AssumedChartHover {
  getPointer: () => ChartHoverPointer | null;
  subscribe: (listener: () => void) => () => void;
}

const LinkedHoverContext = createContext<LinkedChartHoverStore | null>(null);

const createLinkedHoverStore = (): LinkedChartHoverStore => {
  let hover: LinkedHoverState | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: LinkedHoverState | null) => {
    hover = next;
    for (const listener of listeners) listener();
  };
  return {
    getHover: () => hover,
    getSnapshot: () => hover?.pointer ?? null,
    report: (sourceId, pointer) => {
      if (pointer === null) {
        // A chart that another chart has already taken the hover over from must
        // not clear it on its way out.
        if (hover?.sourceId !== sourceId) return;
        publish(null);
        return;
      }
      if (hover?.sourceId === sourceId && hover.pointer.xRatio === pointer.xRatio && hover.pointer.yRatio === pointer.yRatio) return;
      publish({ sourceId, pointer });
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeHover: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

export const chartHoverPointer = (element: HTMLElement, clientX: number, clientY: number): ChartHoverPointer => {
  const rect = element.getBoundingClientRect();
  return {
    xRatio: (clientX - rect.left - chartMargins.left) / chartPlotWidth(rect.width),
    yRatio: (clientY - rect.top) / rect.height,
  };
};

/** The plot position a pointer share stands for, in the chart box. */
export const chartPointerOffset = (pointer: ChartHoverPointer, rect: DOMRect): { x: number; y: number } => ({
  x: chartMargins.left + pointer.xRatio * chartPlotWidth(rect.width),
  y: pointer.yRatio * rect.height,
});

// A hover is a position, not a time: every chart answers the pointer's own
// share of the plot with the point nearest that position. Both plot libraries
// pick the nearest point on the axis -- Fluent bisects the series and keeps the
// nearer of the straddling pair, Recharts walks the ticks and stops at the
// midpoint -- and both keep the earlier of two equidistant points, so the two
// agree on which point a position selects.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/charts/react-charts/library/src/components/AreaChart/AreaChart.tsx#L192-L227
// https://github.com/recharts/recharts/blob/v3.10.1/src/util/getActiveCoordinate.ts#L180-L207
export const nearestChartPoint = <T,>(points: readonly T[], position: number, at: (point: T) => number): T | null => {
  let nearest: T | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const candidate = Math.abs(at(point) - position);
    if (candidate >= distance) continue;
    nearest = point;
    distance = candidate;
  }
  return nearest;
};

export function LinkedChartHoverProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createLinkedHoverStore);
  return <LinkedHoverContext value={store}>{children}</LinkedHoverContext>;
}

export const useLinkedChartHover = () => {
  const id = useId();
  const context = useContext(LinkedHoverContext);
  const [localStore] = useState(createLinkedHoverStore);
  const store = context ?? localStore;
  const report = useCallback((pointer: ChartHoverPointer | null) => store.report(id, pointer), [id, store]);
  useEffect(() => () => store.report(id, null), [id, store]);
  const assumedHover = useMemo<AssumedChartHover>(() => ({
    getPointer: () => {
      const hover = store.getHover();
      return hover === null || hover.sourceId === id ? null : hover.pointer;
    },
    subscribe: store.subscribeHover,
  }), [id, store]);
  return { assumedHover, pointerStore: store, report };
};

export function LinkedChartAssumedHover<T>({ children, hover, resolve }: {
  children: (point: T) => ReactNode;
  hover: AssumedChartHover;
  resolve: (pointer: ChartHoverPointer) => T | null;
}) {
  const pointer = useSyncExternalStore(hover.subscribe, hover.getPointer, hover.getPointer);
  if (pointer === null) return null;
  const point = resolve(pointer);
  return point === null ? null : children(point);
}
