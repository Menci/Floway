import type { UpstreamModel } from '@floway-dev/upstream';

export interface KimiCodeUpstreamData {
  standardModelId?: string;
  fastModelId?: string;
}

export const selectKimiCodeModel = (model: UpstreamModel, fast: boolean): { modelId: string; lane: 'fast' | 'standard' } | undefined => {
  const lanes = model.upstreamData as KimiCodeUpstreamData;
  if (fast && lanes.fastModelId !== undefined) return { modelId: lanes.fastModelId, lane: 'fast' };
  return lanes.standardModelId === undefined ? undefined : { modelId: lanes.standardModelId, lane: 'standard' };
};
