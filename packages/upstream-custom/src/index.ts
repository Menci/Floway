import { getCustomModels } from './catalog.ts';
import { assertCustomUpstreamRecord } from './config.ts';
import { CUSTOM_DEFAULT_FLAGS } from './defaults.ts';
import type { UpstreamRecord, UpstreamScheduledOptions } from '@floway-dev/upstream';

export const customUpstreamModule = {
  defaultFlags: CUSTOM_DEFAULT_FLAGS,
  getModels: getCustomModels,
  async runScheduledTask(record: UpstreamRecord, _options: UpstreamScheduledOptions): Promise<void> {
    assertCustomUpstreamRecord(record);
  },
};

export { projectCustomManualModels, projectCustomModels } from './catalog.ts';
export { assertCustomUpstreamRecord, validateCustomManualModels, type CustomAuthStyle, type CustomIngressHeaderRule, type CustomModelsFetch, type CustomUpstreamConfig } from './config.ts';
export { fetchCustomModels, type CustomModelsResponse, type CustomRawModel } from './fetch-models.ts';
export { customPipelines } from './pipelines/index.ts';
