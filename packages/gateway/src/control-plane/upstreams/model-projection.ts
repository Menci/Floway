import type { ListedUpstreamModel } from './types.ts';
import type { ProviderModel } from '@floway-dev/provider';

export const reshapeModelForDashboard = (model: ProviderModel): ListedUpstreamModel => ({
  upstreamModelId: model.upstreamModelId,
  publicModelId: model.id,
  kind: model.kind,
  endpoints: model.endpoints,
  ...(model.display_name !== undefined ? { display_name: model.display_name } : {}),
  ...(Object.keys(model.limits).length > 0 ? { limits: model.limits } : {}),
  ...(model.pricing ? { pricing: model.pricing } : {}),
  ...(model.chat ? { chat: model.chat } : {}),
  opaqueBlobCompatibilityScope: model.opaqueBlobCompatibilityScope,
  ...(model.flagOverrides ? { flagOverrides: model.flagOverrides } : {}),
});
