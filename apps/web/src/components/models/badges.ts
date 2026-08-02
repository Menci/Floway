import type { CatalogIndex } from './catalog-index';
import { reachableTargets } from './reachability';
import type { ControlPlaneModel } from '../../api/types';
import { ALIAS_RULE_BADGE_FIELDS, formatAliasRuleBadges, type AliasRuleBadge, type AliasRuleBadgeField, type AliasTarget } from '@floway-dev/protocols/common';

export type ModelBadge =
  | { key: string; kind: 'limit'; limit: 'context' | 'prompt' | 'output'; value: string }
  // The raw model id, not the display name: the badge mirrors the wire.
  | { key: string; kind: 'aliasOfModel'; target: string }
  | { key: string; kind: 'aliasOfCount'; reachable: number; total: number }
  | { key: string; kind: 'selection'; selection: 'random' | 'first-available' }
  | { key: string; kind: 'rule'; field: AliasRuleBadgeField; value: AliasRuleBadge['value'] | null; varies: boolean };

// Not the app's compact formatter, which renders 128K and 12.8万 under zh-Hans;
// a spec is quoted as its documentation writes it.
const formatTokenLimit = (count: number): string => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count % 1_000 === 0 ? 0 : 1)}k`;
  return String(count);
};

export const effectiveUpstreams = (
  model: ControlPlaneModel,
  catalog: CatalogIndex,
  cap: readonly string[] | null,
): readonly ControlPlaneModel['upstreams'][number][] => {
  if (model.aliasedFrom === undefined) return cap === null
    ? model.upstreams
    : model.upstreams.filter(binding => cap.includes(binding.id));
  const seen = new Set<string>();
  return reachableTargets(model, catalog, cap).flatMap(target => target.upstreams.filter(binding => {
    if ((cap !== null && !cap.includes(binding.id)) || seen.has(binding.id)) return false;
    seen.add(binding.id);
    return true;
  }));
};

const ruleBadges = (targets: readonly AliasTarget[]): ModelBadge[] => {
  if (targets.length === 1) {
    return formatAliasRuleBadges(targets[0]!.rules)
      .map(badge => ({ key: `rule:${badge.field}`, kind: 'rule' as const, field: badge.field, value: badge.value, varies: false }));
  }
  const formatted = targets.map(target => new Map(
    formatAliasRuleBadges(target.rules).map(badge => [badge.field, badge.value]),
  ));
  const fields = new Set<AliasRuleBadgeField>();
  for (const target of targets) {
    for (const badge of formatAliasRuleBadges(target.rules)) fields.add(badge.field);
  }
  return ALIAS_RULE_BADGE_FIELDS.filter(field => fields.has(field)).map(field => {
    const values = formatted.map(target => target.get(field));
    const first = values[0];
    const varies = first === undefined || values.some(value => value !== first);
    return {
      key: `rule:${field}`,
      kind: 'rule' as const,
      field,
      value: varies ? null : first!,
      varies,
    };
  });
};

export const modelBadges = (
  model: ControlPlaneModel,
  catalog: CatalogIndex,
  cap: readonly string[] | null,
): ModelBadge[] => {
  const badges: ModelBadge[] = ([
    ['context', model.limits.max_context_window_tokens],
    ['prompt', model.limits.max_prompt_tokens],
    ['output', model.limits.max_output_tokens],
  ] as const).flatMap(([limit, value]) => value === undefined
    ? []
    : [{ key: `limit:${limit}`, kind: 'limit' as const, limit, value: formatTokenLimit(value) }]);

  const alias = model.aliasedFrom;
  if (alias === undefined) return badges;

  const reachable = reachableTargets(model, catalog, cap);
  const reachableIds = new Set(reachable.map(target => target.id));
  const reachableAliasTargets = alias.targets.filter(target => reachableIds.has(target.target_model_id));
  const sole = reachable.length === 1 ? reachable[0]! : null;
  badges.push(sole === null
    ? { key: 'aliasOf', kind: 'aliasOfCount', reachable: reachable.length, total: alias.targets.length }
    : { key: 'aliasOf', kind: 'aliasOfModel', target: sole.id });
  if (reachable.length > 1) badges.push({ key: 'selection', kind: 'selection', selection: alias.selection });
  return [...badges, ...ruleBadges(reachableAliasTargets)];
};
