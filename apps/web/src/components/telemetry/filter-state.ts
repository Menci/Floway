export const clearGroupedTelemetryFilters = <Filters extends Record<string, string[]>>(
  filters: Filters,
  groupBy: string,
): Filters => ({
  ...filters,
  ...(groupBy === 'userId' || groupBy === 'keyId'
    ? { userId: [], keyId: [] }
    : { [groupBy]: [] }),
});

export const scopeTelemetryIdentity = <Filters extends Record<string, string[]>, Group extends string>(
  groupBy: Group,
  filters: Filters,
  userDimensionAvailable: boolean,
  fallbackGroup: Group,
): { groupBy: Group; filters: Filters } => {
  const scopedFilters = userDimensionAvailable ? filters : { ...filters, userId: [] };
  if (groupBy !== 'userId' || userDimensionAvailable) return { groupBy, filters: scopedFilters };
  return {
    groupBy: fallbackGroup,
    filters: clearGroupedTelemetryFilters(scopedFilters, fallbackGroup),
  };
};
