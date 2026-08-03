import type { ChartProps } from '@fluentui/react-charts';

import type { ChartSeries } from './series-legends';

// Hiding a series takes it out of the plot and leaves the chart model whole, so
// the callout still reports every bucket the model aggregated.
export const visibleSeriesData = (entries: readonly ChartSeries[], data: ChartProps, hidden: ReadonlySet<string>): ChartProps => {
  const visible = new Set(entries.filter(entry => !hidden.has(entry.id)).map(entry => entry.legend));
  return { ...data, lineChartData: data.lineChartData?.filter(series => visible.has(series.legend)) };
};

export const toggledSeries = (hidden: ReadonlySet<string>, id: string): Set<string> => {
  const next = new Set(hidden);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

export const invertedSeries = (ids: readonly string[], hidden: ReadonlySet<string>): Set<string> =>
  new Set(ids.filter(id => !hidden.has(id)));

// Isolating the only visible series has nowhere left to go, so the same gesture reverses it.
export const isolatedSeries = (ids: readonly string[], hidden: ReadonlySet<string>, id: string): Set<string> => {
  const visible = ids.filter(candidate => !hidden.has(candidate));
  return visible.length === 1 && visible[0] === id
    ? new Set()
    : new Set(ids.filter(candidate => candidate !== id));
};
