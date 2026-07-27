import type { AliasTarget, ChatAliasRules, ControlPlaneModel, ModelKind } from "../../api/types";

export function findCatalogModel(models: readonly ControlPlaneModel[] | null | undefined, id: string) {
  return (models ?? []).find((model) => model.id === id && model.aliasedFrom === undefined);
}

export function realModelIdsOfKind(models: readonly ControlPlaneModel[] | null | undefined, kind: ModelKind) {
  return (models ?? [])
    .filter((model) => model.aliasedFrom === undefined && model.kind === kind)
    .map((model) => model.id);
}

export type RuleWarningField =
  | "reasoning.effort"
  | "reasoning.budget_tokens"
  | "reasoning.adaptive";

export interface RuleWarning {
  field: RuleWarningField;
  key: string;
  values?: Record<string, string | number>;
}

export function computeRuleWarnings(rules: ChatAliasRules, model: ControlPlaneModel | undefined): RuleWarning[] {
  const warnings: RuleWarning[] = [];
  const reasoning = model?.chat?.reasoning;
  const effort = rules.reasoning?.effort;
  if (effort !== undefined) {
    const supported = reasoning?.effort?.supported;
    if (!supported) warnings.push({ field: "reasoning.effort", key: "notAdvertisedEffort" });
    else if (!supported.includes(effort)) warnings.push({ field: "reasoning.effort", key: "unsupportedEffort", values: { values: supported.join(", ") } });
  }
  const budget = rules.reasoning?.budget_tokens;
  if (rules.reasoning?.adaptive === true && budget !== undefined) {
    warnings.push({ field: "reasoning.budget_tokens", key: "adaptiveBudgetConflict" });
  }
  if (budget !== undefined) {
    const range = reasoning?.budget_tokens;
    if (!range) warnings.push({ field: "reasoning.budget_tokens", key: "notAdvertisedBudget" });
    else {
      if (range.min !== undefined && budget < range.min) warnings.push({ field: "reasoning.budget_tokens", key: "budgetBelow", values: { value: range.min } });
      if (range.max !== undefined && budget > range.max) warnings.push({ field: "reasoning.budget_tokens", key: "budgetAbove", values: { value: range.max } });
    }
  }
  if (rules.reasoning?.adaptive === true && reasoning?.adaptive !== true) {
    warnings.push({ field: "reasoning.adaptive", key: "notAdvertisedAdaptive" });
  }
  return warnings;
}

export function computeModelWarning(id: string, model: ControlPlaneModel | undefined, kind: ModelKind) {
  if (!id) return null;
  if (!model) return { key: "unknownTarget", values: { id } };
  if (model.kind !== kind) return { key: "wrongKind", values: { id, actual: model.kind, expected: kind } };
  return null;
}

export type AliasWarning =
  | { type: "shadow"; key: "shadow"; values: { id: string; display: string } }
  | { type: "no-target"; key: "noTarget"; values?: undefined };

export function computeAliasWarnings(
  alias: { name: string; targets: readonly Pick<AliasTarget, "target_model_id">[] },
  models: readonly ControlPlaneModel[] | null | undefined,
): AliasWarning[] {
  const warnings: AliasWarning[] = [];
  const shadowed = (models ?? []).find((model) =>
    model.id === alias.name && model.aliasedFrom === undefined && model.unlisted !== true,
  );
  if (shadowed && !alias.targets.some((target) => target.target_model_id === alias.name)) {
    warnings.push({ type: "shadow", key: "shadow", values: { id: shadowed.id, display: shadowed.display_name === shadowed.id ? "" : shadowed.display_name } });
  }
  if (models != null) {
    const addressable = new Set(models.filter((model) => model.aliasedFrom === undefined).map((model) => model.id));
    if (!alias.targets.some((target) => addressable.has(target.target_model_id))) {
      warnings.push({ type: "no-target", key: "noTarget" });
    }
  }
  return warnings;
}
