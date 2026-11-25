import { assertAzureUpstreamRecord } from './config.ts';
import { Secret } from '@floway-dev/pipeline';
import type { ProviderUpstream, UpstreamRecord } from '@floway-dev/provider';

interface AzureUpstreamFactConfig {
  readonly endpoint: string;
  readonly apiKey: Secret<string>;
}

export const azureUpstreamFact = (record: UpstreamRecord): ProviderUpstream<'azure', AzureUpstreamFactConfig> => {
  const { id, kind, name, config } = assertAzureUpstreamRecord(record);
  return { id, kind, name, config: { endpoint: config.endpoint, apiKey: Secret.from(config.apiKey) } };
};
