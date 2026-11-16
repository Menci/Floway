import type { ProviderModel } from '@floway-dev/provider';

export interface KimiCodeProviderData {
  standardModelId?: string;
  fastModelId?: string;
}

export const kimiCodeFastModelId = (model: ProviderModel): string | undefined => (model.providerData as KimiCodeProviderData).fastModelId;

export const selectKimiCodeModelId = (model: ProviderModel, fast: boolean): string | undefined => {
  const lanes = model.providerData as KimiCodeProviderData;
  return fast ? lanes.fastModelId ?? lanes.standardModelId : lanes.standardModelId;
};
