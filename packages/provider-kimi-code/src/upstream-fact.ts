import { assertKimiCodeUpstreamRecord, type KimiCodeUpstreamConfig } from './config.ts';
import { Secret } from '@floway-dev/pipeline';
import type { ProviderUpstream, UpstreamRecord } from '@floway-dev/provider';

type KimiCodePipelineConfig = Omit<KimiCodeUpstreamConfig, 'apiKey'> & { readonly apiKey: Secret<string> };

export type KimiCodeUpstreamFact = ProviderUpstream<'kimi-code', KimiCodePipelineConfig>;

export const kimiCodeUpstreamFact = (record: UpstreamRecord): KimiCodeUpstreamFact => {
  const { id, kind, name, config } = assertKimiCodeUpstreamRecord(record);
  return { id, kind, name, config: { region: config.region, apiKey: Secret.from(config.apiKey) } };
};
