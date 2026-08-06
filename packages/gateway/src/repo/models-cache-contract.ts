import type { ModelsCacheGeneration } from './types.ts';
import { serializeStoredConfig } from './upstream-json.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

// Persisted ProviderModel rows contain code-derived metadata as well as the
// upstream response. Increment this whenever that derived catalog contract or
// its serialization changes so older rows become cold across deployments.
export const MODEL_CATALOG_REVISION = 5;

// Fetch ownership survives provider-managed state writes such as token
// rotation, but changes whenever static request inputs or egress policy do.
export const modelsFetchIdentity = (
  record: Pick<UpstreamRecord, 'kind' | 'config' | 'proxyFallbackList'>,
): string => serializeStoredConfig({
  kind: record.kind,
  config: record.config,
  proxyFallbackList: record.proxyFallbackList,
});

// Control-plane credential and transport changes reset refresh cooldown even
// when the provider says the previous catalog remains valid.
export const modelsOperatorRefreshIdentity = (
  record: Pick<UpstreamRecord, 'kind' | 'config' | 'state' | 'proxyFallbackList'>,
): string => serializeStoredConfig({
  kind: record.kind,
  config: record.config,
  state: record.state ?? null,
  proxyFallbackList: record.proxyFallbackList,
});

export const modelsCacheGeneration = (
  record: Pick<UpstreamRecord, 'updatedAt' | 'kind' | 'config' | 'proxyFallbackList'>,
): ModelsCacheGeneration => ({
  updatedAt: record.updatedAt,
  fetchIdentity: modelsFetchIdentity(record),
});
