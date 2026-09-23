import { normalizeFlagOverrides } from './flag-overrides.ts';
import { normalizeProxyFallbackList } from './proxy-fallback-list.ts';
import { serializeStoredConfig } from './upstream-json.ts';
import { sha256JsonHex, type UpstreamRecord } from '@floway-dev/provider';

type RefreshInputs = Pick<UpstreamRecord, 'kind' | 'config' | 'flagOverrides' | 'proxyFallbackList'>;

export const modelsRefreshInputs = (record: RefreshInputs) => ({
  provider: record.kind,
  configJson: serializeStoredConfig(record.config),
  flagOverridesJson: JSON.stringify(normalizeFlagOverrides(record.flagOverrides)),
  proxyFallbackListJson: JSON.stringify(normalizeProxyFallbackList(record.proxyFallbackList)),
});

export const modelsRefreshInputHash = (record: RefreshInputs): string => sha256JsonHex(modelsRefreshInputs(record));

export const matchesModelsRefreshInputs = (record: RefreshInputs, expected: ReturnType<typeof modelsRefreshInputs>): boolean => {
  const current = modelsRefreshInputs(record);
  return current.provider === expected.provider
    && current.configJson === expected.configJson
    && current.flagOverridesJson === expected.flagOverridesJson
    && current.proxyFallbackListJson === expected.proxyFallbackListJson;
};
