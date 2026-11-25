import { assertCustomUpstreamRecord, type CustomUpstreamConfig } from './config.ts';
import { Secret } from '@floway-dev/pipeline';
import type { ProviderUpstream, UpstreamRecord } from '@floway-dev/provider';

type CustomUpstreamFactConfig = Pick<CustomUpstreamConfig, 'baseUrl' | 'pathOverrides' | 'ingressHeadersRules'> & {
  readonly apiKey?: Secret<string>;
};

export const customUpstreamFact = (record: UpstreamRecord): ProviderUpstream<'custom', CustomUpstreamFactConfig> => {
  const { id, kind, name, config: { apiKey, baseUrl, pathOverrides, ingressHeadersRules } } = assertCustomUpstreamRecord(record);
  return {
    id,
    kind,
    name,
    config: {
      baseUrl,
      ingressHeadersRules,
      ...(pathOverrides === undefined ? {} : { pathOverrides }),
      ...(apiKey === '' ? {} : { apiKey: Secret.from(apiKey) }),
    },
  };
};
