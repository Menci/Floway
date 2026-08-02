import type { CatalogIndex } from './catalog-index';
import { indexCatalog } from './catalog-index';
import type { ControlPlaneModel } from '../../api/types';

export const effectiveUpstreamCap = (
  keyUpstreamIds: readonly string[] | null,
  userUpstreamIds: readonly string[] | null,
): readonly string[] | null => {
  if (keyUpstreamIds === null && userUpstreamIds === null) return null;
  if (keyUpstreamIds === null) return userUpstreamIds;
  if (userUpstreamIds === null) return keyUpstreamIds;
  const userCap = new Set(userUpstreamIds);
  return keyUpstreamIds.filter(id => userCap.has(id));
};

const realModelReachable = (
  model: ControlPlaneModel,
  cap: readonly string[] | null,
) => cap === null || model.upstreams.some(upstream => cap.includes(upstream.id));

export const reachableTargets = (
  alias: ControlPlaneModel,
  catalog: CatalogIndex,
  cap: readonly string[] | null,
): readonly ControlPlaneModel[] => {
  if (alias.aliasedFrom === undefined) return [];
  return alias.aliasedFrom.targets.flatMap(target => {
    const resolved = catalog.get(target.target_model_id);
    return resolved !== undefined && realModelReachable(resolved, cap) ? [resolved] : [];
  });
};

export const isModelReachable = (
  model: ControlPlaneModel,
  catalog: CatalogIndex,
  cap: readonly string[] | null,
): boolean => model.aliasedFrom === undefined
  ? realModelReachable(model, cap)
  : reachableTargets(model, catalog, cap).length > 0;

export const reachableModels = (
  catalog: readonly ControlPlaneModel[],
  cap: readonly string[] | null,
  accept: (model: ControlPlaneModel) => boolean = () => true,
): ControlPlaneModel[] => {
  const index = indexCatalog(catalog);
  return catalog.filter(model => accept(model) && isModelReachable(model, index, cap));
};
