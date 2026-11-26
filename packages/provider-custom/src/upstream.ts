import { assertCustomUpstreamRecord, type CustomIngressHeaderRule, type CustomPathOverrideKey } from './config.ts';
import { Secret } from '@floway-dev/pipeline';
import type { ProviderUpstream, UpstreamRecord } from '@floway-dev/provider';

export type CustomUpstream = ProviderUpstream<'custom', {
  readonly baseUrl: string;
  readonly apiKey?: Secret<string>;
  readonly ingressHeadersRules: readonly CustomIngressHeaderRule[];
  readonly pathOverrides?: Readonly<Partial<Record<CustomPathOverrideKey, string>>>;
}>;

export const toCustomUpstream = (record: UpstreamRecord): CustomUpstream => {
  const { id, kind, name, config } = assertCustomUpstreamRecord(record);
  const { baseUrl, apiKey, ingressHeadersRules, pathOverrides } = config;
  return {
    id,
    kind,
    name,
    config: {
      baseUrl,
      ...(apiKey !== '' && { apiKey: Secret.from(apiKey) }),
      ingressHeadersRules,
      ...(pathOverrides !== undefined && { pathOverrides }),
    },
  };
};
