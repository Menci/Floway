export const clearGroupedTelemetryFilters = <Filters extends object>(
  filters: Filters,
  groupBy: keyof Filters & string,
): Filters => ({ ...filters, ...(groupBy === 'userId' || groupBy === 'keyId'
    ? { userId: [], keyId: [] }
    : { [groupBy]: [] }) }) as Filters;

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

export const telemetryFilterDimensions = <Dimension extends { key: string }>(
  dimensions: readonly Dimension[],
  groupBy: string,
): Dimension[] => dimensions.filter(dimension => (
  dimension.key !== groupBy
  && !((dimension.key === 'userId' || dimension.key === 'keyId') && (groupBy === 'userId' || groupBy === 'keyId'))
));
