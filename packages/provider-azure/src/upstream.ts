import { assertAzureUpstreamRecord } from './config.ts';
import { Secret } from '@floway-dev/pipeline';
import type { ProviderUpstream, UpstreamRecord } from '@floway-dev/provider';

export type AzureUpstream = ProviderUpstream<'azure', {
  readonly endpoint: string;
  readonly apiKey: Secret<string>;
}>;

export const toAzureUpstream = (record: UpstreamRecord): AzureUpstream => {
  const { id, kind, name, config } = assertAzureUpstreamRecord(record);
  return { id, kind, name, config: { endpoint: config.endpoint, apiKey: Secret.from(config.apiKey) } };
};
