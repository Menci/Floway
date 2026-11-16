import { object, string } from './validation.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

export interface KimiCodeUpstreamConfig {
  region: 'china' | 'overseas';
  apiKey: string;
}

export type KimiCodeUpstreamRecord = UpstreamRecord & {
  kind: 'kimi-code';
  config: KimiCodeUpstreamConfig;
};

export const parseKimiCodeUpstreamConfig = (value: unknown): KimiCodeUpstreamConfig => {
  const config = object(value, 'Malformed kimi-code upstream config');
  if (config.region !== 'china' && config.region !== 'overseas') throw new TypeError('Malformed kimi-code upstream config: region must be china or overseas');
  return { region: config.region, apiKey: string(config.apiKey, 'Malformed kimi-code upstream config: apiKey') };
};

export const assertKimiCodeUpstreamRecord = (record: UpstreamRecord): KimiCodeUpstreamRecord => {
  if (record.kind !== 'kimi-code') throw new TypeError(`Expected kimi-code upstream record, got ${record.kind}`);
  return { ...record, kind: 'kimi-code', config: parseKimiCodeUpstreamConfig(record.config) };
};

// Account identity and quota belong to the credential; the regional coding
// endpoints serve the same subscription.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
export const kimiCodeStateSurvivesConfigChange = (previous: unknown, next: KimiCodeUpstreamConfig): boolean =>
  parseKimiCodeUpstreamConfig(previous).apiKey === next.apiKey;
