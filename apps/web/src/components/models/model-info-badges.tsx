import { useTranslation } from 'react-i18next';

import { effectiveUpstreams, modelBadges, type ModelBadge } from './model-badges';
import type { ControlPlaneModel } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { ProviderBadge } from '../upstreams/provider-badge';

const { Badge, makeStyles, tokens } = fluentComponents;

const useStyles = makeStyles({
  badge: {
    // Fluent sizes Badge text for a count, not a phrase; the metadata these
    // carry reads as body text, and matching the provider badge's height
    // keeps one row out of two weights.
    fontWeight: tokens.fontWeightRegular,
    minHeight: '22px',
    paddingInline: tokens.spacingHorizontalSNudge,
  },
});

const badgeText = (badge: ModelBadge, t: ReturnType<typeof useTranslation>['t']): string => {
  switch (badge.kind) {
  case 'limit':
    return t(`dashboard.playground.badges.${badge.limit}`, { value: badge.value });
  case 'aliasOfModel':
    return t('dashboard.playground.badges.aliasOfModel', { target: badge.target });
  case 'aliasOfCount':
    return badge.reachable === badge.total
      ? t('dashboard.playground.badges.aliasOfCount', { count: badge.total })
      : t('dashboard.playground.badges.aliasOfPartial', { reachable: badge.reachable, total: badge.total });
  case 'selection':
    return t('dashboard.playground.badges.selection', { selection: badge.selection });
  case 'rule':
    return badge.label;
  }
};

// The model row's capability summary: which upstreams a request would reach,
// the token limits the catalog advertises, and — for an alias — what it
// resolves to under the caller's current upstream cap.
export function ModelInfoBadges({ cap, catalog, model }: {
  cap: readonly string[] | null;
  catalog: readonly ControlPlaneModel[];
  model: ControlPlaneModel;
}) {
  const { t } = useTranslation();
  const styles = useStyles();

  return (
    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
      {effectiveUpstreams(model, catalog, cap).map(upstream => (
        <ProviderBadge key={upstream.id} color={upstream.color} kind={upstream.kind} label={upstream.name} />
      ))}
      {modelBadges(model, catalog, cap).map(badge => (
        <Badge key={badge.key} appearance="tint" className={styles.badge} color="informative" shape="rounded" size="medium">
          {badgeText(badge, t)}
        </Badge>
      ))}
    </div>
  );
}
