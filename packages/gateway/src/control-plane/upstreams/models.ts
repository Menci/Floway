import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { isValidProviderKind, upstreamErrorMessage as errorMessage } from './shared.ts';
import { MODEL_LISTING_FAILURE_MESSAGE } from '../../data-plane/models/shared.ts';
import { fetchUpstreamModelsCached } from '../../data-plane/providers/models-cache.ts';
import { createProvider } from '../../data-plane/providers/registry.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { listModelsBody } from '../schemas.ts';
import { ProviderModelsUnavailableError, type Fetcher, type ProviderModel, type ProxyFallbackEntry, type UpstreamRecord } from '@floway-dev/provider';
import { assertCustomUpstreamRecord, fetchCustomModels } from '@floway-dev/provider-custom';
import { assertOllamaUpstreamRecord, createOllamaProvider } from '@floway-dev/provider-ollama';

// `upstreamModelId` is the wire-side identifier the provider will send when
// a caller invokes the public `model.id` — claude-code exposes
// `claude-sonnet-4-5` publicly while sending `claude-sonnet-4-5-20250929`
// on the wire, and other providers may distinguish similarly through their
// opaque `providerData` blob.
const reshapeModelForDashboard = (model: ProviderModel): Record<string, unknown> => {
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

// Unified model catalog fetch for both draft preview and saved-record
// refresh. Always live-fetches on the control plane; when
// record.id !== '' the request also warms/refreshes the SWR cache via
// `fetchUpstreamModelsCached` so a subsequent data-plane call picks up
// the fresh catalog. Custom's response stays the raw upstream row shape
// (dashboard translates through the draft's endpoints); every other
// kind returns UpstreamModelConfig-shaped rows.
export const listModels = async (c: CtxWithJson<typeof listModelsBody>) => {
  const { record } = c.req.valid('json');
  if (!isValidProviderKind(record.kind)) {
    return c.json({ error: { message: `Invalid kind: ${record.kind}`, type: 'invalid_request_error' } }, 400);
  }
  const kind = record.kind;

  const scheduler = backgroundSchedulerFromContext(c);
  const now = new Date().toISOString();
  const synthRecord: UpstreamRecord = {
    id: record.id || 'draft',
    kind,
    name: 'draft',
    enabled: true,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: (record.proxy_fallback_list ?? []) as ProxyFallbackEntry[],
    modelPrefix: null,
    color: null,
    config: record.config,
    state: record.state,
  };

  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxy_fallback_list,
      upstreamId: record.id || undefined,
      runtimeLocation: getRuntimeLocation(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  try {
    if (kind === 'custom') {
      const assertedConfig = assertCustomUpstreamRecord(synthRecord).config;
      const result = await fetchCustomModels(assertedConfig, fetcher);
      return c.json(result);
    }
    if (kind === 'ollama') {
      assertOllamaUpstreamRecord(synthRecord);
      const instance = createOllamaProvider(synthRecord);
      const models = await instance.instance.getProvidedModels(fetcher);
      return c.json({ data: models.map(reshapeModelForDashboard) });
    }
    // Copilot / codex / claude-code / azure — use the provider factory.
    // Force through the SWR cache when the record is persisted so the
    // side-effect refresh keeps the data-plane cache in step; otherwise
    // live-fetch without any caching.
    const provider = createProvider(synthRecord);
    const models = record.id !== ''
      ? await fetchUpstreamModelsCached(provider, { scheduler, fetcher, force: true })
      : await provider.instance.getProvidedModels(fetcher);
    return c.json({ data: models.map(reshapeModelForDashboard) });
  } catch (e) {
    if (e instanceof ProviderModelsUnavailableError) {
      return c.json({ error: { message: MODEL_LISTING_FAILURE_MESSAGE, type: 'api_error' } }, 502);
    }
    if (e instanceof Error && /Malformed .* upstream config/.test(e.message)) {
      return c.json({ error: errorMessage(e) }, 400);
    }
    throw e;
  }
};
