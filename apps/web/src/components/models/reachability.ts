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

// The alias targets the caller could actually route to right now. A target
// whose id resolves to no catalog row — operator typo, model withdrawn — is
// unreachable, as is one whose every binding sits outside the cap.
export const reachableTargets = (
  alias: ControlPlaneModel,
  catalog: readonly ControlPlaneModel[],
  cap: readonly string[] | null,
): readonly ControlPlaneModel[] => {
  if (alias.aliasedFrom === undefined) return [];
  return alias.aliasedFrom.targets.flatMap(target => {
    const resolved = catalog.find(
      candidate => candidate.id === target.target_model_id && candidate.aliasedFrom === undefined,
    );
    return resolved !== undefined && realModelReachable(resolved, cap) ? [resolved] : [];
  });
};

export const isModelReachable = (
  model: ControlPlaneModel,
  catalog: readonly ControlPlaneModel[],
  cap: readonly string[] | null,
): boolean => model.aliasedFrom === undefined
  ? realModelReachable(model, cap)
  : reachableTargets(model, catalog, cap).length > 0;
