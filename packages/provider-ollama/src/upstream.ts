import { assertOllamaUpstreamRecord, type OllamaUpstreamConfig } from './config.ts';
import { Secret } from '@floway-dev/pipeline';
import type { ProviderUpstream, UpstreamRecord } from '@floway-dev/provider';

type OllamaPipelineConfig = Pick<OllamaUpstreamConfig, 'baseUrl' | 'cloudUsage'> & {
  apiKey?: Secret<string>;
  configVersion: number;
};

export type OllamaUpstream = ProviderUpstream<'ollama', OllamaPipelineConfig>;

export const toOllamaUpstream = (record: UpstreamRecord & { configVersion: number }): OllamaUpstream => {
  const { config: { baseUrl, cloudUsage, apiKey }, id, kind, name } = assertOllamaUpstreamRecord(record);
  return {
    id,
    kind,
    name,
    config: { baseUrl, cloudUsage, ...(apiKey === undefined ? {} : { apiKey: Secret.from(apiKey) }), configVersion: record.configVersion },
  };
};
