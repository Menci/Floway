export const telemetryDimensionExcludedByGroup = (groupBy: string, dimension: string): boolean =>
  dimension === groupBy || (groupBy === 'userId' && dimension === 'keyId');

export const clearGroupedTelemetryFilters = <Filters extends object>(
  filters: Filters,
  groupBy: keyof Filters & string,
): Filters => Object.fromEntries(Object.entries(filters).map(([dimension, values]) => [
  dimension,
  telemetryDimensionExcludedByGroup(groupBy, dimension) ? [] : values,
])) as Filters;

interface TelemetryIdentityContext<Group extends string> {
  currentUserId: string;
  fallbackGroup: Group;
  userDimensionAvailable: boolean;
}

interface TelemetryIdentityState<Filters, Group extends string> {
  filters: Filters;
  groupBy: Group;
}

type TelemetryIdentityFilters = { userId: string[]; keyId: string[] };

const isCurrentUserOnly = (values: readonly string[], currentUserId: string): boolean =>
  values.length === 1 && values[0] === currentUserId;

const reconcileTelemetryIdentityFilters = <Filters extends TelemetryIdentityFilters>(
  filters: Filters,
  context: TelemetryIdentityContext<string>,
): Filters => {
  if (!context.userDimensionAvailable) return { ...filters, userId: [] };
  if (filters.userId.length > 0 && !isCurrentUserOnly(filters.userId, context.currentUserId)) {
    return { ...filters, keyId: [] };
  }
  if (filters.keyId.length > 0) return { ...filters, userId: [context.currentUserId] };
  return filters;
};

export const scopeTelemetryIdentity = <Filters extends TelemetryIdentityFilters, Group extends keyof Filters & string>(
  groupBy: Group,
  filters: Filters,
  context: TelemetryIdentityContext<Group>,
): TelemetryIdentityState<Filters, Group> => {
  const groupedFilters = clearGroupedTelemetryFilters(filters, groupBy);
  const scopedFilters = reconcileTelemetryIdentityFilters(groupedFilters, context) as Filters;
  if (groupBy === 'keyId') {
    return {
      groupBy,
      filters: {
        ...scopedFilters,
        userId: context.userDimensionAvailable ? [context.currentUserId] : [],
      } as Filters,
    };
  }
  if (groupBy !== 'userId' || context.userDimensionAvailable) return { groupBy, filters: scopedFilters };
  return {
    groupBy: context.fallbackGroup,
    filters: clearGroupedTelemetryFilters(scopedFilters, context.fallbackGroup),
  };
};

export const changeTelemetryGroupBy = <Filters extends TelemetryIdentityFilters, Group extends keyof Filters & string>(
  state: TelemetryIdentityState<Filters, Group>,
  groupBy: Group,
  context: TelemetryIdentityContext<Group>,
): TelemetryIdentityState<Filters, Group> => scopeTelemetryIdentity(
  groupBy,
  clearGroupedTelemetryFilters(state.filters, groupBy),
  context,
);

export const changeTelemetryFilter = <Filters extends TelemetryIdentityFilters, Group extends keyof Filters & string>(
  state: TelemetryIdentityState<Filters, Group>,
  dimension: Group,
  values: string[],
  context: TelemetryIdentityContext<Group>,
): TelemetryIdentityState<Filters, Group> => {
  const filters = { ...state.filters, [dimension]: values };
  if (dimension === 'keyId' && values.length > 0 && context.userDimensionAvailable) {
    return scopeTelemetryIdentity(state.groupBy, {
      ...filters,
      userId: [context.currentUserId],
    }, context);
  }
  if (dimension === 'userId' && !isCurrentUserOnly(values, context.currentUserId)) {
    const groupBy = state.groupBy === 'keyId' ? context.fallbackGroup : state.groupBy;
    return scopeTelemetryIdentity(groupBy, {
      ...clearGroupedTelemetryFilters(filters, groupBy),
      keyId: [],
    }, context);
  }
  return scopeTelemetryIdentity(state.groupBy, filters, context);
};
