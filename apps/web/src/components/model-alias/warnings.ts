import type { ControlPlaneModel } from '../../api/types';
import type { TFunction } from '../../i18n/translation';
import type { CatalogIndex } from '../models/catalog-index';
import type { AliasTarget, ChatAliasRules, ModelKind } from '@floway-dev/protocols/common';

export const realModelIdsOfKind = (models: readonly ControlPlaneModel[] | null | undefined, kind: ModelKind) => {
  return (models ?? [])
    .filter(model => model.aliasedFrom === undefined && model.kind === kind)
    .map(model => model.id);
};

export type RuleWarning =
  | { field: 'reasoning.effort'; key: 'notAdvertisedEffort' }
  | { field: 'reasoning.effort'; key: 'unsupportedEffort'; values: { values: string } }
  | { field: 'reasoning.budget_tokens'; key: 'adaptiveBudgetConflict' }
  | { field: 'reasoning.budget_tokens'; key: 'notAdvertisedBudget' }
  | { field: 'reasoning.budget_tokens'; key: 'budgetBelow' | 'budgetAbove'; values: { value: number } }
  | { field: 'reasoning.adaptive'; key: 'notAdvertisedAdaptive' };

export type RuleWarningField = RuleWarning['field'];

export const computeRuleWarnings = (rules: ChatAliasRules, model: ControlPlaneModel | undefined): RuleWarning[] => {
  const warnings: RuleWarning[] = [];
  const reasoning = model?.chat?.reasoning;
  const effort = rules.reasoning?.effort;
  if (effort !== undefined) {
    const supported = reasoning?.effort?.supported;
    if (!supported) warnings.push({ field: 'reasoning.effort', key: 'notAdvertisedEffort' });
    else if (!supported.includes(effort)) warnings.push({ field: 'reasoning.effort', key: 'unsupportedEffort', values: { values: supported.join(', ') } });
  }
  const budget = rules.reasoning?.budget_tokens;
  if (rules.reasoning?.adaptive === true && budget !== undefined) {
    warnings.push({ field: 'reasoning.budget_tokens', key: 'adaptiveBudgetConflict' });
  }
  if (budget !== undefined) {
    const range = reasoning?.budget_tokens;
    if (!range) warnings.push({ field: 'reasoning.budget_tokens', key: 'notAdvertisedBudget' });
    else {
      if (range.min !== undefined && budget < range.min) warnings.push({ field: 'reasoning.budget_tokens', key: 'budgetBelow', values: { value: range.min } });
      if (range.max !== undefined && budget > range.max) warnings.push({ field: 'reasoning.budget_tokens', key: 'budgetAbove', values: { value: range.max } });
    }
  }
  if (rules.reasoning?.adaptive === true && reasoning?.adaptive !== true) {
    warnings.push({ field: 'reasoning.adaptive', key: 'notAdvertisedAdaptive' });
  }
  return warnings;
};

export type ModelWarning =
  | { key: 'unknownTarget'; values: { id: string } }
  | { key: 'wrongKind'; values: { id: string; actual: ModelKind; expected: ModelKind } };

export const computeModelWarning = (
  id: string,
  model: ControlPlaneModel | undefined,
  kind: ModelKind,
): ModelWarning | null => {
  if (!id) return null;
  if (!model) return { key: 'unknownTarget', values: { id } };
  if (model.kind !== kind) return { key: 'wrongKind', values: { id, actual: model.kind, expected: kind } };
  return null;
};

export type AliasWarning =
  | { type: 'shadow'; key: 'shadow'; values: { id: string; display: string } }
  | { type: 'no-target'; key: 'noTarget'; values?: undefined };

export const computeAliasWarnings = (
  alias: { name: string; targets: readonly Pick<AliasTarget, 'target_model_id'>[] },
  catalog: CatalogIndex | null,
): AliasWarning[] => {
  const warnings: AliasWarning[] = [];
  const named = catalog?.get(alias.name);
  const shadowed = named?.unlisted !== true ? named : undefined;
  if (shadowed && !alias.targets.some(target => target.target_model_id === alias.name)) {
    warnings.push({ type: 'shadow', key: 'shadow', values: { id: shadowed.id, display: shadowed.display_name === shadowed.id ? '' : shadowed.display_name } });
  }
  // A new alias opens on one blank row, so warning before anything is typed
  // would report the starting state as a fault.
  const entered = alias.targets.filter(target => target.target_model_id !== '');
  if (catalog !== null && entered.length > 0 && !entered.some(target => catalog.has(target.target_model_id))) {
    warnings.push({ type: 'no-target', key: 'noTarget' });
  }
  return warnings;
};

export const modelAliasWarningText = (
  warning: AliasWarning | ModelWarning | RuleWarning,
  t: TFunction,
): string => {
  switch (warning.key) {
  case 'shadow': return t('dashboard.modelAliases.warnings.shadow', warning.values);
  case 'noTarget': return t('dashboard.modelAliases.warnings.noTarget');
  case 'unknownTarget': return t('dashboard.modelAliases.warnings.unknownTarget', warning.values);
  case 'wrongKind': return t('dashboard.modelAliases.warnings.wrongKind', warning.values);
  case 'notAdvertisedEffort': return t('dashboard.modelAliases.warnings.notAdvertisedEffort');
  case 'unsupportedEffort': return t('dashboard.modelAliases.warnings.unsupportedEffort', warning.values);
  case 'adaptiveBudgetConflict': return t('dashboard.modelAliases.warnings.adaptiveBudgetConflict');
  case 'notAdvertisedBudget': return t('dashboard.modelAliases.warnings.notAdvertisedBudget');
  case 'budgetBelow': return t('dashboard.modelAliases.warnings.budgetBelow', warning.values);
  case 'budgetAbove': return t('dashboard.modelAliases.warnings.budgetAbove', warning.values);
  case 'notAdvertisedAdaptive': return t('dashboard.modelAliases.warnings.notAdvertisedAdaptive');
  }
};
