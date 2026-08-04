import type { ReactNode } from 'react';

import { effectiveUpstreams, modelBadges, type ModelBadge } from './badges';
import type { CatalogIndex } from './catalog-index';
import type { ControlPlaneModel } from '../../api/types';
import { Trans, type TFunction, useTranslation } from '../../i18n/translation';
import { Chip } from '../ui/chip';
import { ProviderBadge } from '../upstreams/provider-badge';

// One step under the chip's 12px caption, so the monospace face does not
// out-measure the proportional text beside it.
const modelValueClassName = 'font-mono mono-size-xs';

// The badge builder gives this field a token count; the surrounding union is
// wide enough to hold the string-valued rules too, so the number is asserted
// rather than stringified — the interpolation has to receive a number to be
// grouped.
const budgetTokens = (value: Extract<ModelBadge, { kind: 'rule' }>['value']): number => {
  if (typeof value !== 'number') throw new TypeError(`Reasoning budget badge carries ${typeof value}, not a number.`);
  return value;
};

const ruleBadgeContent = (
  badge: Extract<ModelBadge, { kind: 'rule' }>,
  t: TFunction,
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
  case 'reasoning.budget_tokens': return <Trans components={components} i18nKey="dashboard.models.badges.rules.reasoningBudget" values={{ value: budgetTokens(badge.value) }} />;
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
  t: TFunction,
): ReactNode => {
  const strong = { strong: <strong /> };
  switch (badge.kind) {
  case 'aliasOfModel':
    return <Trans components={{ model: <strong className={modelValueClassName} /> }} i18nKey="dashboard.models.badges.aliasOfModel" values={{ target: badge.target }} />;
  case 'aliasOfCount':
    return badge.reachable === badge.total ? (
      <Trans components={strong} count={badge.total} i18nKey="dashboard.models.badges.aliasOfCount" />
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

export function ModelInfoBadges({ cap, catalog, model }: {
  cap: readonly string[] | null;
  catalog: CatalogIndex;
  model: ControlPlaneModel;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
      {effectiveUpstreams(model, catalog, cap).map(upstream => (
        <ProviderBadge key={upstream.id} label={upstream.name} upstream={upstream} />
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
