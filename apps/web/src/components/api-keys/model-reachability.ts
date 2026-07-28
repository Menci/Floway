import type { ControlPlaneModel } from '../../api/types';
import { effectiveUpstreamCap, isModelReachable } from '../models/reachability';

export const modelsForAgentSetup = (
  catalog: readonly ControlPlaneModel[],
  keyUpstreamIds: readonly string[] | null,
  userUpstreamIds: readonly string[] | null,
) => {
  const cap = effectiveUpstreamCap(keyUpstreamIds, userUpstreamIds);
  return catalog.filter(model => isModelReachable(model, catalog, cap));
};
