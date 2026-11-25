import { assertKimiCodeUpstreamRecord, type KimiCodeUpstreamConfig } from './config.ts';
import { Secret } from '@floway-dev/pipeline';
import type { ProviderUpstream, UpstreamRecord } from '@floway-dev/provider';

type KimiCodePipelineConfig = Pick<KimiCodeUpstreamConfig, 'region'> & {
  apiKey: Secret<string>;
  configVersion: number;
};

export type KimiCodeUpstream = ProviderUpstream<'kimi-code', KimiCodePipelineConfig>;

export const toKimiCodeUpstream = (record: UpstreamRecord & { configVersion: number }): KimiCodeUpstream => {
  const { config, id, kind, name } = assertKimiCodeUpstreamRecord(record);
  return {
    id,
    kind,
    name,
    config: { region: config.region, apiKey: Secret.from(config.apiKey), configVersion: record.configVersion },
  };
};
