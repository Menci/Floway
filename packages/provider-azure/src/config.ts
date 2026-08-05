import { azureEndpointField } from './endpoint.ts';
import { type UpstreamModelConfig, type UpstreamRecord, isHttpFieldValue, isRecord, modelsField, nonEmptyStringField } from '@floway-dev/provider';

export interface AzureUpstreamConfig {
  endpoint: string;
  apiKey: string;
  models: UpstreamModelConfig[];
}

export type AzureUpstreamRecord = UpstreamRecord & {
  kind: 'azure';
  config: AzureUpstreamConfig;
};

export const assertAzureUpstreamRecord = (record: UpstreamRecord): AzureUpstreamRecord => {
  if (record.kind !== 'azure') throw new Error(`Expected azure upstream record, got ${record.kind}`);
  if (!isRecord(record.config)) throw new Error('Malformed azure upstream config: config must be an object');

  const models = modelsField(record.config.models, 'azure');
  if (models.length === 0) throw new Error('Malformed azure upstream config: models must be a non-empty array');
  if (models.some(model => model.endpoints.rerank !== undefined)) {
    throw new Error('Malformed azure upstream config: rerank models require a custom upstream');
  }

  const apiKey = nonEmptyStringField(record.config.apiKey, 'azure upstream config: apiKey');
  if (!isHttpFieldValue(apiKey)) throw new Error('Malformed azure upstream config: apiKey is not a valid HTTP header value');
  const config: AzureUpstreamConfig = {
    endpoint: azureEndpointField(record.config.endpoint, 'azure upstream config: endpoint'),
    apiKey,
    models,
  };

  return {
    ...record,
    kind: 'azure',
    config,
  };
};
