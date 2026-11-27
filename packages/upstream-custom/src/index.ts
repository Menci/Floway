import { CUSTOM_DEFAULT_FLAGS } from './defaults.ts';
import { createCustomUpstream } from './upstream.ts';
import type { UpstreamModule } from '@floway-dev/upstream';

export const customUpstreamModule: UpstreamModule = {
  create: createCustomUpstream,
  defaultFlags: CUSTOM_DEFAULT_FLAGS,
};

export { assertCustomUpstreamRecord, validateCustomManualModels, type CustomAuthStyle, type CustomIngressHeaderRule, type CustomModelsFetch, type CustomUpstreamConfig } from './config.ts';
export { fetchCustomModels, type CustomModelsResponse, type CustomRawModel } from './fetch-models.ts';
export { projectCustomManualModels, projectCustomModels } from './upstream.ts';
