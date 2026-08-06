import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { isValidProviderKind, upstreamErrorMessage as errorMessage } from './shared.ts';
import type { ListedUpstreamModel } from './types.ts';
import { MODEL_LISTING_FAILURE_CODE, MODEL_LISTING_FAILURE_MESSAGE } from '../../data-plane/models/shared.ts';
import { fetchUpstreamModels } from '../../data-plane/providers/models-refresh.ts';
import { createProvider, modelsRequestIdentity } from '../../data-plane/providers/registry.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { modelsCacheGeneration } from '../../repo/models-cache-contract.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { listModelsBody } from '../schemas.ts';
import { ProviderModelsUnavailableError, type Fetcher, type ProviderModel, type ProxyFallbackEntry, type UpstreamRecord } from '@floway-dev/provider';
import { assertCustomUpstreamRecord, fetchCustomModels, projectCustomModels } from '@floway-dev/provider-custom';

// `upstreamModelId` is the wire-side identifier the provider will send when
// a caller invokes the public `model.id` — Claude Code exposes
// `claude-sonnet-4-5` publicly while sending `claude-sonnet-4-5-20250929`
// on the wire. `providerData` is opaque provider-private invocation data,
// not a universal upstream-id field: only the providers that shape it as
// `{ upstreamModelId }` surface a distinct wire id here, and the rest
// (Copilot carries its raw variant list there) report the public id.
const reshapeModelForDashboard = (model: ProviderModel): ListedUpstreamModel => {
  const providerData = typeof model.providerData === 'object' && model.providerData !== null ? model.providerData as { upstreamModelId?: unknown } : null;
  const wireId = typeof providerData?.upstreamModelId === 'string' && providerData.upstreamModelId.length > 0 ? providerData.upstreamModelId : model.id;
  return {
    upstreamModelId: wireId,
    publicModelId: model.id,
    kind: model.kind,
    endpoints: model.endpoints,
    ...(model.display_name !== undefined ? { display_name: model.display_name } : {}),
    ...(Object.keys(model.limits).length > 0 ? { limits: model.limits } : {}),
    ...(model.pricing ? { pricing: model.pricing } : {}),
    ...(model.chat ? { chat: model.chat } : {}),
    ...(model.flagOverrides ? { flagOverrides: model.flagOverrides } : {}),
  };
};

// Unified model catalog fetch for draft previews and saved records. A request
// matching the saved fetch inputs atomically publishes its result to the
// persisted snapshot; an unsaved draft is fetched without touching that row.
// Custom keeps the raw upstream response shape for the dashboard; every other
// provider returns its ProviderModel projection.
export const listModels = async (c: CtxWithJson<typeof listModelsBody>) => {
  const { record } = c.req.valid('json');
  if (!isValidProviderKind(record.kind)) {
    return c.json({ error: { message: `Invalid kind: ${record.kind}`, type: 'invalid_request_error' } }, 400);
  }
  const kind = record.kind;
  const persisted = record.id === '' ? null : await getRepo().upstreams.getById(record.id);
  if (record.id !== '' && persisted === null) return c.json({ error: 'Upstream not found' }, 404);
  const effectiveProxyFallbackList = (record.proxy_fallback_list ?? persisted?.proxyFallbackList ?? []) as ProxyFallbackEntry[];

  const now = new Date().toISOString();
  const synthRecord: UpstreamRecord = {
    id: record.id || 'draft',
    kind,
    name: 'draft',
    enabled: true,
    sortOrder: 0,
    createdAt: now,
    updatedAt: persisted?.updatedAt ?? now,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: effectiveProxyFallbackList,
    modelPrefix: null,
    // A draft only lists models; nothing renders its badge.
    hue: 0,
    config: record.config,
    state: record.state,
    // A draft is built from the request envelope and lists models live, so it
    // never carries a cached catalog.
    modelsCache: null,
  };
  const canRefreshPersistedCache = persisted !== null
    && modelsRequestIdentity(persisted) === modelsRequestIdentity(synthRecord);

  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({
      override: effectiveProxyFallbackList,
      upstreamId: record.id || undefined,
      runtimeLocation: getRuntimeLocation(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  try {
    if (kind === 'custom') {
      const assertedConfig = assertCustomUpstreamRecord(synthRecord).config;
      const provider = createProvider(synthRecord, persisted === null ? undefined : modelsCacheGeneration(persisted));
      let result: Awaited<ReturnType<typeof fetchCustomModels>> | undefined;
      if (!canRefreshPersistedCache) {
        result = await fetchCustomModels(assertedConfig, fetcher);
      } else {
        await fetchUpstreamModels(provider, fetcher, async () => {
          result = await fetchCustomModels(assertedConfig, fetcher);
          return projectCustomModels(synthRecord, result);
        });
        // A concurrent refresh may already own the cache's in-flight slot, in
        // which case our raw-shape loader was not invoked. The dashboard still
        // needs its raw response, so only that joined-flight case fetches it
        // separately.
        result ??= await fetchCustomModels(assertedConfig, fetcher);
      }
      return c.json({ kind, data: result.data });
    }
    // Copilot / codex / claude-code / azure / ollama use the provider factory.
    const provider = createProvider(synthRecord, persisted === null ? undefined : modelsCacheGeneration(persisted));
    const models = canRefreshPersistedCache
      ? await fetchUpstreamModels(provider, fetcher)
      : await provider.instance.getProvidedModels(fetcher);
    return c.json({ kind, data: models.map(reshapeModelForDashboard) });
  } catch (e) {
    if (e instanceof ProviderModelsUnavailableError) {
      return c.json({ error: { message: MODEL_LISTING_FAILURE_MESSAGE, type: 'api_error', code: MODEL_LISTING_FAILURE_CODE } }, 502);
    }
    if (e instanceof Error && /Malformed .* upstream config/.test(e.message)) {
      return c.json({ error: errorMessage(e) }, 400);
    }
    throw e;
  }
};
