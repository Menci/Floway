import type { ModelsCacheGeneration, StoredUpstreamRecord } from './types.ts';

// Persisted ProviderModel rows contain code-derived metadata as well as the
// upstream response. Increment this whenever that derived catalog contract or
// its serialization changes so older rows become cold across deployments.
export const MODEL_CATALOG_REVISION = 5;

// Refresh publication survives provider-managed state writes such as token
// rotation, but is fenced whenever static request inputs or egress policy change.
export const modelsCacheGeneration = (
  record: Pick<StoredUpstreamRecord, 'configVersion'>,
): ModelsCacheGeneration => ({
  configVersion: record.configVersion,
});
