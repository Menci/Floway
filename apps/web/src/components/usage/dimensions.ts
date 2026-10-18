import type { UsageGroupBy, UsageOverviewResponse, UsageUpstream } from './types';
import type { TFunction } from '../../i18n/translation';
import type { TelemetryDimension } from '../telemetry/dimension-controls';
import { tokenUsageUnattributedUserId, usageUpstreamDimensionValue, usageUpstreamFromDimensionValue } from '@floway-dev/protocols/browser';

const requiredLabel = (labels: ReadonlyMap<string, string>, value: string, dimension: string) => {
  const label = labels.get(value);
  if (label === undefined) throw new TypeError(`Usage ${dimension} dimension is missing metadata for ${value}`);
  return label;
};

export const usageDimensions = ({ usage, upstreams, currentUserId, t }: {
  usage: UsageOverviewResponse;
  upstreams: readonly UsageUpstream[];
  currentUserId: string;
  t: TFunction;
}): Array<TelemetryDimension<UsageGroupBy>> => {
  const upstreamNames = new Map(upstreams.map(upstream => [usageUpstreamDimensionValue(upstream.id), upstream.name]));
  const unknownUpstreamLabel = t('dashboard.usage.filters.unknownUpstream');
  for (const value of usage.dimensionValues.upstreams) {
    if (!upstreamNames.has(value)) upstreamNames.set(value, usageUpstreamFromDimensionValue(value) ?? unknownUpstreamLabel);
  }
  const users = new Map(usage.users.map(user => [String(user.id), user.username]));
  const keys = new Map(usage.keys.map(key => [key.id, key.name]));
  const userIds = [...new Set([
    ...usage.users.map(user => String(user.id)),
    ...usage.dimensionValues.userIds.map(String),
  ])];
  const dimensions: Array<TelemetryDimension<UsageGroupBy>> = [
    { key: 'model', groupLabel: t('dashboard.usage.groupBy.model'), filterLabel: t('dashboard.usage.filters.model'), allLabel: t('dashboard.usage.filters.all.model'), options: usage.dimensionValues.models.map(value => ({ value, label: value })) },
    { key: 'upstream', groupLabel: t('dashboard.usage.groupBy.upstream'), filterLabel: t('dashboard.usage.filters.upstream'), allLabel: t('dashboard.usage.filters.all.upstream'), options: usage.dimensionValues.upstreams.map(value => ({ value, label: requiredLabel(upstreamNames, value, 'upstream') })) },
    {
      key: 'userId',
      groupLabel: t('dashboard.usage.groupBy.userId'),
      filterLabel: t('dashboard.usage.filters.userId'),
      allLabel: t('dashboard.usage.filters.all.userId'),
      options: userIds.map(value => ({ value, label: Number(value) === tokenUsageUnattributedUserId ? t('dashboard.usage.filters.unknownUser') : requiredLabel(users, value, 'user') })),
      selectionLabel: values => values.length === 1 && values[0] === currentUserId
        ? t('dashboard.telemetry.currentUserOnly')
        : t('dashboard.usage.filters.selected', { count: values.length }),
    },
    { key: 'keyId', groupLabel: t('dashboard.usage.groupBy.keyId'), filterLabel: t('dashboard.usage.filters.keyId'), allLabel: t('dashboard.usage.filters.all.keyId'), options: usage.dimensionValues.keyIds.map(value => ({ value, label: requiredLabel(keys, value, 'API key') })) },
  ];
  return dimensions;
};
