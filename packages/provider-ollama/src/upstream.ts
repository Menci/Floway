import { assertOllamaUpstreamRecord } from './config.ts';
import { Secret } from '@floway-dev/pipeline';
import type { ProviderUpstream, UpstreamRecord } from '@floway-dev/provider';

interface OllamaUpstreamFactConfig {
  readonly baseUrl: string;
  readonly cloudUsage: boolean;
  readonly apiKey?: Secret<string>;
}

export const ollamaUpstreamFact = (record: UpstreamRecord): ProviderUpstream<'ollama', OllamaUpstreamFactConfig> => {
  const { id, kind, name, config: { apiKey, baseUrl, cloudUsage } } = assertOllamaUpstreamRecord(record);
  return {
    id,
    kind,
    name,
    config: { baseUrl, cloudUsage, ...(apiKey === undefined ? {} : { apiKey: Secret.from(apiKey) }) },
  };
};
