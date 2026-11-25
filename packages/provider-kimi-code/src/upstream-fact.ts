import { assertKimiCodeUpstreamRecord, type KimiCodeUpstreamConfig } from './config.ts';
import { Secret } from '@floway-dev/pipeline';
import type { ProviderUpstream, UpstreamRecord } from '@floway-dev/provider';

type KimiCodePipelineConfig = Omit<KimiCodeUpstreamConfig, 'apiKey'> & { readonly apiKey: Secret<string> };

export const kimiCodeUpstreamFact = (record: UpstreamRecord): ProviderUpstream<'kimi-code', KimiCodePipelineConfig> => {
  const { id, kind, name, config } = assertKimiCodeUpstreamRecord(record);
  return { id, kind, name, config: { region: config.region, apiKey: Secret.from(config.apiKey) } };
};

export const kimiCodePipelineConfig = (upstream: ProviderUpstream): KimiCodePipelineConfig => {
  if (upstream.kind !== 'kimi-code' || typeof upstream.config !== 'object' || upstream.config === null) {
    throw new TypeError(`Expected Kimi Code upstream config for ${upstream.id}`);
  }
  const { apiKey, region } = upstream.config as Record<string, unknown>;
  if (!(apiKey instanceof Secret) || (region !== 'china' && region !== 'overseas')) {
    throw new TypeError(`Malformed Kimi Code pipeline config for ${upstream.id}`);
  }
  return { apiKey, region } as KimiCodePipelineConfig;
};
