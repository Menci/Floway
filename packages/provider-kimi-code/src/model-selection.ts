import type { ProviderModel } from '@floway-dev/provider';

export interface KimiCodeProviderData {
  standardModelId?: string;
  fastModelId?: string;
}

export const selectKimiCodeModel = (model: ProviderModel, fast: boolean): { modelId: string; lane: 'fast' | 'standard' } | undefined => {
  const lanes = model.providerData as KimiCodeProviderData;
  if (fast && lanes.fastModelId !== undefined) return { modelId: lanes.fastModelId, lane: 'fast' };
  return lanes.standardModelId === undefined ? undefined : { modelId: lanes.standardModelId, lane: 'standard' };
};
