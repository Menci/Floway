import { azureEndpointField } from './endpoint.ts';
import { type UpstreamModelConfig, type UpstreamRecord, isRecord, modelsField, nonEmptyStringField } from '@floway-dev/upstream';

export interface AzureUpstreamConfig {
  endpoint: string;
  apiKey: string;
}

export type AzureUpstreamRecord = UpstreamRecord & {
  kind: 'azure';
  config: AzureUpstreamConfig;
};

export const validateAzureManualModels = (value: unknown): UpstreamModelConfig[] => {
  const models = modelsField(value, 'azure');
  if (models.length === 0) throw new Error('Malformed azure upstream config: models must be a non-empty array');
  if (models.some(model => model.kind === 'rerank')) {
    throw new Error('Malformed azure upstream config: rerank models require a custom upstream');
  }
  // Foundry serves decision models over System One, a fixed dialect, so an
  // operator-supplied target could only contradict the provider.
  if (models.some(model => model.kind === 'decision' && model.decisionTarget !== undefined)) {
    throw new Error('Malformed azure upstream config: decision target is not configurable on this upstream');
  }
  return models;
};

export const assertAzureUpstreamRecord = (record: UpstreamRecord): AzureUpstreamRecord => {
  return {
    ...record,
    kind: 'azure',
    config: readAzureUpstreamConfig(record),
  };
};

export const readAzureUpstreamConfig = ({ kind, config }: Pick<UpstreamRecord, 'kind' | 'config'>): AzureUpstreamConfig => {
  if (kind !== 'azure') throw new Error(`Expected azure upstream record, got ${kind}`);
  if (!isRecord(config)) throw new Error('Malformed azure upstream config: config must be an object');
  return {
    endpoint: azureEndpointField(config.endpoint, 'azure upstream config: endpoint'),
    apiKey: nonEmptyStringField(config.apiKey, 'azure upstream config: apiKey'),
  };
};
