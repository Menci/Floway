import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import type { CatalogIndex } from './catalog-index';
import { effectiveUpstreams, modelBadges, type ModelBadge } from './model-badges';
import type { ControlPlaneModel } from '../../api/types';
import { Chip } from '../ui/chip';
import { ProviderBadge } from '../upstreams/provider-badge';

// A model id inside a chip is set in the monospace face at the smallest step
// of the shared mono scale, which is one pixel under the 12px caption the chip
// runs at, so the monospace face does not out-measure the proportional text
// beside it. The chip's own colour, its caption size and the semibold weight
// of a `strong` are all stated once elsewhere -- by Fluent's outline Tag, by
// its caption ramp, and by global.css -- so nothing here restates them.
const modelValueClassName = 'font-mono mono-size-xs';

const ruleBadgeContent = (
  badge: Extract<ModelBadge, { kind: 'rule' }>,
  t: ReturnType<typeof useTranslation>['t'],
): ReactNode => {
  if (badge.varies) {
    switch (badge.field) {
    case 'reasoning.effort': return t('dashboard.models.badges.ruleVaries.reasoningEffort');
    case 'reasoning.budget_tokens': return t('dashboard.models.badges.ruleVaries.reasoningBudget');
    case 'reasoning.adaptive': return t('dashboard.models.badges.ruleVaries.reasoningAdaptive');
    case 'reasoning.summary': return t('dashboard.models.badges.ruleVaries.reasoningSummary');
    case 'verbosity': return t('dashboard.models.badges.ruleVaries.verbosity');
    case 'serviceTier': return t('dashboard.models.badges.ruleVaries.serviceTier');
    }
  }
  const components = { strong: <strong /> };
  switch (badge.field) {
  case 'reasoning.effort': return <Trans components={components} i18nKey="dashboard.models.badges.rules.reasoningEffort" values={{ value: String(badge.value) }} />;
  case 'reasoning.budget_tokens': return <Trans components={components} i18nKey="dashboard.models.badges.rules.reasoningBudget" values={{ value: String(badge.value) }} />;
  case 'reasoning.adaptive':
    return badge.value === true
      ? t('dashboard.models.badges.rules.adaptive')
      : t('dashboard.models.badges.rules.nonAdaptive');
  case 'reasoning.summary': return <Trans components={components} i18nKey="dashboard.models.badges.rules.reasoningSummary" values={{ value: String(badge.value) }} />;
  case 'verbosity': return <Trans components={components} i18nKey="dashboard.models.badges.rules.verbosity" values={{ value: String(badge.value) }} />;
  case 'serviceTier': return <Trans components={components} i18nKey="dashboard.models.badges.rules.serviceTier" values={{ value: String(badge.value) }} />;
  }
};

const badgeContent = (
  badge: Exclude<ModelBadge, { kind: 'limit' }>,
  t: ReturnType<typeof useTranslation>['t'],
): ReactNode => {
  const strong = { strong: <strong /> };
  switch (badge.kind) {
  case 'aliasOfModel':
    return <Trans components={{ model: <strong className={modelValueClassName} /> }} i18nKey="dashboard.models.badges.aliasOfModel" values={{ target: badge.target }} />;
  case 'aliasOfCount':
    return badge.reachable === badge.total ? (
      <Trans components={strong} count={badge.total} i18nKey="dashboard.models.badges.aliasOfCount" values={{ count: badge.total }} />
    ) : (
      <Trans components={strong} i18nKey="dashboard.models.badges.aliasOfPartial" values={{ reachable: badge.reachable, total: badge.total }} />
    );
  case 'selection':
    return <Trans
      components={strong}
      i18nKey="dashboard.models.badges.selection"
      values={{
        selection: t(badge.selection === 'first-available'
          ? 'dashboard.models.badges.selectionValues.firstAvailable'
          : 'dashboard.models.badges.selectionValues.random'),
      }}
    />;
  case 'rule':
    return ruleBadgeContent(badge, t);
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
  catalog: CatalogIndex;
  model: ControlPlaneModel;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
      {effectiveUpstreams(model, catalog, cap).map(upstream => (
        <ProviderBadge key={upstream.id} color={upstream.color} kind={upstream.kind} label={upstream.name} />
      ))}
      {modelBadges(model, catalog, cap).map(badge => (
        <Chip key={badge.key}>
          {badge.kind === 'limit'
            ? <Trans
                components={{ strong: <strong /> }}
                i18nKey={`dashboard.models.badges.${badge.limit}`}
                values={{ value: badge.value }}
              />
            : badgeContent(badge, t)}
        </Chip>
      ))}
    </div>
  );
}
