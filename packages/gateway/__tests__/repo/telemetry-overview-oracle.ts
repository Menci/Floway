export interface TelemetryDimensionSpec<Row> {
  value: (row: Row) => string | null;
  includeFacet?: (row: Row, value: string) => boolean;
}

export const partitionTelemetryOverviewRecords = <Row, Dimension extends string>(
  rows: readonly Row[],
  dimensions: Record<Dimension, TelemetryDimensionSpec<Row>>,
  filters: Record<Dimension, ReadonlySet<string>>,
): { filtered: Row[]; dimensionValues: Record<Dimension, string[]> } => {
  const entries = Object.entries(dimensions) as Array<[Dimension, TelemetryDimensionSpec<Row>]>;
  const values = Object.fromEntries(entries.map(([dimension]) => [dimension, new Set<string>()])) as Record<Dimension, Set<string>>;
  const filtered: Row[] = [];
  for (const row of rows) {
    let matches = true;
    for (const [dimension, spec] of entries) {
      const value = spec.value(row);
      if (value !== null && (spec.includeFacet?.(row, value) ?? true)) values[dimension].add(value);
      const filter = filters[dimension];
      if (filter.size > 0 && (value === null || !filter.has(value))) matches = false;
    }
    if (matches) filtered.push(row);
  }
  return {
    filtered,
    dimensionValues: Object.fromEntries(entries.map(([dimension]) => [
      dimension,
      [...values[dimension]].sort(),
    ])) as Record<Dimension, string[]>,
  };
};
