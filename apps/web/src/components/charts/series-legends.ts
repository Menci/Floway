// One plotted series, as the legend and the plot each need it: `id` selects it
// and survives a relabelling, `label` names it to the reader, and `colorSlot`
// indexes the palette. `legend` is the disambiguated `label` Fluent keys its own
// series by, so it exists only once a set of entries has been compared against
// each other.
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
