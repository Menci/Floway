import { normalizeFlagOverrides } from './flag-overrides.ts';
import { normalizeProxyFallbackList } from './proxy-fallback-list.ts';
import { serializeStoredConfig } from './upstream-json.ts';
import { sha256JsonHex, type UpstreamRecord } from '@floway-dev/provider';

type RefreshInputs = Pick<UpstreamRecord, 'kind' | 'config' | 'flagOverrides' | 'chatCompletionsReasoningOverrides' | 'proxyFallbackList'>;

export const modelsRefreshInputs = (record: RefreshInputs) => ({
  provider: record.kind,
  configJson: serializeStoredConfig(record.config),
  reasoningOverridesJson: JSON.stringify(record.chatCompletionsReasoningOverrides ?? {}),
  flagOverridesJson: JSON.stringify(normalizeFlagOverrides(record.flagOverrides)),
  proxyFallbackListJson: JSON.stringify(normalizeProxyFallbackList(record.proxyFallbackList)),
});

export const modelsRefreshInputHash = (record: RefreshInputs): string => sha256JsonHex(modelsRefreshInputs(record));

export const matchesModelsRefreshInputs = (record: RefreshInputs, expected: ReturnType<typeof modelsRefreshInputs>): boolean => {
  const current = modelsRefreshInputs(record);
  return current.provider === expected.provider
    && current.configJson === expected.configJson
    && current.reasoningOverridesJson === expected.reasoningOverridesJson
    && current.flagOverridesJson === expected.flagOverridesJson
    && current.proxyFallbackListJson === expected.proxyFallbackListJson;
};
