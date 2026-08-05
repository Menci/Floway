const identityDimensions = new Set(['userId', 'keyId']);

export const telemetryDimensionExcludedByGroup = (groupBy: string, dimension: string): boolean =>
  dimension === groupBy || (identityDimensions.has(groupBy) && identityDimensions.has(dimension));

export const clearGroupedTelemetryFilters = <Filters extends object>(
  filters: Filters,
  groupBy: keyof Filters & string,
): Filters => Object.fromEntries(Object.entries(filters).map(([dimension, values]) => [
  dimension,
  telemetryDimensionExcludedByGroup(groupBy, dimension) ? [] : values,
])) as Filters;

export const scopeTelemetryIdentity = <Filters extends { userId: string[] }, Group extends keyof Filters & string>(
  groupBy: Group,
  filters: Filters,
  userDimensionAvailable: boolean,
  fallbackGroup: Group,
): { groupBy: Group; filters: Filters } => {
  const scopedFilters = (userDimensionAvailable ? filters : { ...filters, userId: [] }) as Filters;
  if (groupBy !== 'userId' || userDimensionAvailable) return { groupBy, filters: scopedFilters };
  return {
    groupBy: fallbackGroup,
    filters: clearGroupedTelemetryFilters(scopedFilters, fallbackGroup),
  };
};
