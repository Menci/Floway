import { Trans, useTranslation } from 'react-i18next';

import { effectiveUpstreams, modelBadges, type ModelBadge } from './model-badges';
import type { ControlPlaneModel } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { Chip } from '../ui/chip';
import { ProviderBadge } from '../upstreams/provider-badge';

const { makeStyles, tokens } = fluentComponents;

const useStyles = makeStyles({
  tag: { color: tokens.colorNeutralForeground2 },
  tagText: { fontSize: '12px', lineHeight: '16px' },
});

const ruleBadgeText = (badge: Extract<ModelBadge, { kind: 'rule' }>, t: ReturnType<typeof useTranslation>['t']): string => {
  if (badge.varies) {
    switch (badge.field) {
    case 'reasoning.effort': return t('dashboard.playground.badges.ruleVaries.reasoningEffort');
    case 'reasoning.budget_tokens': return t('dashboard.playground.badges.ruleVaries.reasoningBudget');
    case 'reasoning.adaptive': return t('dashboard.playground.badges.ruleVaries.reasoningAdaptive');
    case 'reasoning.summary': return t('dashboard.playground.badges.ruleVaries.reasoningSummary');
    case 'verbosity': return t('dashboard.playground.badges.ruleVaries.verbosity');
    case 'serviceTier': return t('dashboard.playground.badges.ruleVaries.serviceTier');
    }
  }
  switch (badge.field) {
  case 'reasoning.effort': return t('dashboard.playground.badges.rules.reasoningEffort', { value: badge.value });
  case 'reasoning.budget_tokens': return t('dashboard.playground.badges.rules.reasoningBudget', { value: badge.value });
  case 'reasoning.adaptive':
    return badge.value === true
      ? t('dashboard.playground.badges.rules.adaptive')
      : t('dashboard.playground.badges.rules.nonAdaptive');
  case 'reasoning.summary': return t('dashboard.playground.badges.rules.reasoningSummary', { value: badge.value });
  case 'verbosity': return t('dashboard.playground.badges.rules.verbosity', { value: badge.value });
  case 'serviceTier': return t('dashboard.playground.badges.rules.serviceTier', { value: badge.value });
  }
};

const badgeText = (badge: Exclude<ModelBadge, { kind: 'limit' }>, t: ReturnType<typeof useTranslation>['t']): string => {
  switch (badge.kind) {
  case 'aliasOfModel':
    return t('dashboard.playground.badges.aliasOfModel', { target: badge.target });
  case 'aliasOfCount':
    return badge.reachable === badge.total
      ? t('dashboard.playground.badges.aliasOfCount', { count: badge.total })
      : t('dashboard.playground.badges.aliasOfPartial', { reachable: badge.reachable, total: badge.total });
  case 'selection':
    return t('dashboard.playground.badges.selection', {
      selection: t(badge.selection === 'first-available'
        ? 'dashboard.playground.badges.selectionValues.firstAvailable'
        : 'dashboard.playground.badges.selectionValues.random'),
    });
  case 'rule':
    return ruleBadgeText(badge, t);
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
        <Chip key={badge.key} className={styles.tag} textClassName={styles.tagText}>
          {badge.kind === 'limit'
            ? <Trans
                components={{ strong: <strong className="font-fui-semibold" /> }}
                i18nKey={`dashboard.playground.badges.${badge.limit}`}
                values={{ value: badge.value }}
              />
            : badgeText(badge, t)}
        </Chip>
      ))}
    </div>
  );
}
