import { assertCustomUpstreamRecord, type CustomIngressHeaderRule, type CustomPathOverrideKey } from './config.ts';
import { secret, type Secret } from '@floway-dev/pipeline';
import type { ProviderUpstreamBase, UpstreamRecord } from '@floway-dev/provider';

export interface CustomUpstreamConfigFacts {
  readonly baseUrl: string;
  readonly apiKey: Secret<string>;
  readonly pathOverrides?: Readonly<Partial<Record<CustomPathOverrideKey, string>>>;
  readonly ingressHeadersRules: readonly Readonly<CustomIngressHeaderRule>[];
}

export type CustomUpstreamFacts = ProviderUpstreamBase<'custom', CustomUpstreamConfigFacts>;

export const toCustomUpstreamFacts = (record: UpstreamRecord): CustomUpstreamFacts => {
  const { config, id, name } = assertCustomUpstreamRecord(record);
  return {
    kind: 'custom', id, name,
    config: {
      baseUrl: config.baseUrl,
      apiKey: secret(config.apiKey),
      ingressHeadersRules: config.ingressHeadersRules,
      ...(config.pathOverrides === undefined ? {} : { pathOverrides: config.pathOverrides }),
    },
  };
};
