import { colorForHue } from './palette';

// Fluent keys its own series by `legend`, so only a compared set carries one.
export interface SeriesLegendEntry {
  id: string;
  label: string;
  hue: number;
  /** Overrides `colorForHue(hue)` for series outside the hue palette (e.g. Other). */
  color?: string | undefined;
}
export type ChartSeries = SeriesLegendEntry & { legend: string };

export const seriesColor = (entry: Pick<SeriesLegendEntry, 'hue' | 'color'>): string =>
  entry.color ?? colorForHue(entry.hue);

// Ranking reorders only the legend: hues and the plot's stacking order stay
// stable, so switching metric moves a tag without recolouring it.
export const rankedLegend = <T extends { id: string }>(
  entries: readonly T[],
  weights?: ReadonlyMap<string, number> | undefined,
): T[] => {
  if (weights === undefined) return [...entries];
  const weightOf = (id: string) => {
    const weight = weights.get(id);
    if (weight === undefined) throw new RangeError(`Legend series has no weight: ${id}`);
    return weight;
  };
  return entries.toSorted((left, right) => weightOf(right.id) - weightOf(left.id));
};

export const withUniqueSeriesLegends = <T extends { id: string; label: string }>(entries: readonly T[]): Array<T & { legend: string }> => {
  const totals = new Map<string, number>();
  for (const entry of entries) totals.set(entry.label, (totals.get(entry.label) ?? 0) + 1);

  const seen = new Map<string, number>();
  return entries.map(entry => {
    const ordinal = (seen.get(entry.label) ?? 0) + 1;
    seen.set(entry.label, ordinal);
    return {
      ...entry,
      legend: totals.get(entry.label) === 1 ? entry.label : `${entry.label} (${ordinal})`,
    };
  });
};
