import type { ControlPlaneModel } from '../../api/types';
import { effectiveUpstreamCap, reachableModels } from '../models/reachability';

export const modelsForAgentSetup = (
  catalog: readonly ControlPlaneModel[],
  keyUpstreamIds: readonly string[] | null,
  userUpstreamIds: readonly string[] | null,
): ControlPlaneModel[] => reachableModels(catalog, effectiveUpstreamCap(keyUpstreamIds, userUpstreamIds));
