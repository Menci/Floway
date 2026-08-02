// Fluent keys its own series by `legend`, so only a compared set carries one.
export interface SeriesLegendEntry { id: string; label: string; colorSlot: number }
export type ChartSeries = SeriesLegendEntry & { legend: string };

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
