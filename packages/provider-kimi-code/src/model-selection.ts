import { object, string } from './validation.ts';
import type { ProviderModelFacts } from '@floway-dev/provider';

export interface KimiCodeProviderData {
  standardModelId?: string;
  fastModelId?: string;
}

export interface KimiCodeModelSelection {
  readonly modelId: string;
  readonly lane: 'fast' | 'standard';
}

export const selectKimiCodeModel = (model: ProviderModelFacts, fast: boolean): KimiCodeModelSelection | undefined => {
  const label = `Kimi Code model ${model.id}`;
  const lanes = object(model.providerData, label);
  if (fast && lanes.fastModelId !== undefined) return { modelId: string(lanes.fastModelId, `${label}.fastModelId`), lane: 'fast' };
  return lanes.standardModelId === undefined ? undefined : { modelId: string(lanes.standardModelId, `${label}.standardModelId`), lane: 'standard' };
};
