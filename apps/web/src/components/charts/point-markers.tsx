import type { ChartProps } from '@fluentui/react-charts';
import { useLayoutEffect } from 'react';

export const seriesRunBoundaryPoints = <T,>(values: readonly (T | null | undefined)[]): boolean[] => {
  const observed = values.flatMap((value, index) => value === null || value === undefined ? [] : [{ index, value }]);
  const markers = values.map(() => false);
  observed.forEach(({ index, value }, observedIndex) => {
    markers[index] = observedIndex === 0
      || observedIndex === observed.length - 1
      || observed[observedIndex - 1]!.value !== value
      || observed[observedIndex + 1]!.value !== value;
  });
  return markers;
};

const markFluentChartPoints = (element: HTMLElement, data: ChartProps, form: 'area' | 'line') => {
  // Fluent keeps a focusable circle for every area observation and a separate
  // highlight circle for optimized line hover. Resizing the observation
  // circles preserves both data-point navigation and pointer callouts.
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/charts/react-charts/library/src/components/AreaChart/AreaChart.tsx#L757-L789
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/charts/react-charts/library/src/components/LineChart/LineChart.tsx#L756-L807
  const regions = [...element.querySelectorAll<SVGGElement>('g[role="region"]')];
  for (const series of data.lineChartData ?? []) {
    const region = regions.find(candidate => candidate.getAttribute('aria-label')?.startsWith(`${series.legend}, `));
    if (region === undefined) continue;
    const circles = [...region.querySelectorAll<SVGCircleElement>('circle[role="img"]')];
    if (circles.length !== series.data.length) continue;
    const markers = seriesRunBoundaryPoints(series.data.map(point => point.y));
    circles.forEach((circle, index) => {
      circle.dataset.chartPointForm = form;
      circle.dataset.chartPointMarker = markers[index] ? 'boundary' : 'interior';
      if (markers[index]) {
        circle.style.setProperty('r', '2px');
        circle.style.setProperty('stroke-width', '1.5px');
      } else if (form === 'line') {
        circle.style.setProperty('r', '0');
        circle.style.setProperty('stroke-width', '0');
      } else {
        circle.style.removeProperty('r');
        circle.style.removeProperty('stroke-width');
      }
    });
  }
};

export function FluentChartPointMarkers({ data, element, form }: { data: ChartProps; element: HTMLElement; form: 'area' | 'line' }) {
  useLayoutEffect(() => {
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        markFluentChartPoints(element, data, form);
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(element, { childList: true, subtree: true });
    schedule();
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [data, element, form]);
  return null;
}
