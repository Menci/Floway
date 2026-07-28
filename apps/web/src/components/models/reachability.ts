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

export const isModelReachable = (
  model: ControlPlaneModel,
  catalog: readonly ControlPlaneModel[],
  cap: readonly string[] | null,
): boolean => {
  if (model.aliasedFrom === undefined) return realModelReachable(model, cap);
  return model.aliasedFrom.targets.some(target => {
    const resolved = catalog.find(
      candidate => candidate.id === target.target_model_id && candidate.aliasedFrom === undefined,
    );
    return resolved !== undefined && realModelReachable(resolved, cap);
  });
};
