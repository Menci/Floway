import { useTranslation } from 'react-i18next';

import { effectiveUpstreams, modelBadges, type ModelBadge } from './model-badges';
import type { ControlPlaneModel } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { Chip } from '../ui/chip';
import { ProviderBadge } from '../upstreams/provider-badge';

const { makeStyles, tokens } = fluentComponents;

const useStyles = makeStyles({
  tag: { color: tokens.colorNeutralForeground2 },
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
//
// These are attributes of the selected model, which is what Fluent's Tag
// represents; Badge is a decoration for a UI element, and CounterBadge and
// PresenceBadge cover the count and status cases. A Tag that is not
// dismissible renders as a plain span, so the row states facts without
// offering an interaction it does not have.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-tags/stories/src/Tag/TagDescription.md
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-badge/stories/src/Badge/BadgeDescription.md
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
        <Chip key={badge.key} className={styles.tag}>{badgeText(badge, t)}</Chip>
      ))}
    </div>
  );
}
