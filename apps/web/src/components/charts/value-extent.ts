import type { ChartProps } from '@fluentui/react-charts';

export interface ValueExtent { minimum: number; maximum: number }

export const positiveValueExtent = (values: Iterable<number>): ValueExtent | null => {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!(value > 0)) continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return minimum === Number.POSITIVE_INFINITY ? null : { minimum, maximum };
};

export const positiveLineChartExtent = (data: ChartProps): ValueExtent | null => {
  function* values() {
    for (const series of data.lineChartData ?? []) {
      for (const point of series.data) yield point.y;
    }
  }
  return positiveValueExtent(values());
};
