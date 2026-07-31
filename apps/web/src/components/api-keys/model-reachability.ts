import type { ControlPlaneModel } from '../../api/types';
import { indexCatalog } from '../models/catalog-index';
import { effectiveUpstreamCap, isModelReachable } from '../models/reachability';

export const modelsForAgentSetup = (
  catalog: readonly ControlPlaneModel[],
  keyUpstreamIds: readonly string[] | null,
  userUpstreamIds: readonly string[] | null,
) => {
  const cap = effectiveUpstreamCap(keyUpstreamIds, userUpstreamIds);
  const index = indexCatalog(catalog);
  return catalog.filter(model => isModelReachable(model, index, cap));
};
