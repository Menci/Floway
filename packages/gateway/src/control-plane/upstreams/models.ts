import { modelsCacheStatus } from './models-cache-status.ts';
import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { isValidProviderKind, upstreamErrorMessage as errorMessage } from './shared.ts';
import { MODEL_LISTING_FAILURE_CODE, MODEL_LISTING_FAILURE_MESSAGE } from '../../data-plane/models/shared.ts';
import { fetchUpstreamModels } from '../../data-plane/providers/models-refresh.ts';
import { createPreviewProvider, createProvider } from '../../data-plane/providers/registry.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { previewModelsBody } from '../schemas.ts';
import { ProviderModelsUnavailableError, type Fetcher, type ProviderModel, type ProxyFallbackEntry, type UpstreamModelConfig, type UpstreamRecord } from '@floway-dev/provider';
import { assertCustomUpstreamRecord, fetchCustomModels, projectCustomModels, projectCustomDiscoveredModels } from '@floway-dev/provider-custom';

// `upstreamModelId` is the wire-side identifier the provider will send when
// a caller invokes the public `model.id` — Claude Code exposes
// `claude-sonnet-4-5` publicly while sending `claude-sonnet-4-5-20250929`
// on the wire. `providerData` is opaque provider-private invocation data,
// not a universal upstream-id field: only the providers that shape it as
// `{ upstreamModelId }` surface a distinct wire id here, and the rest
// (Copilot carries its raw variant list there) report the public id.
const reshapeModelForDashboard = (model: ProviderModel): UpstreamModelConfig => {
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

const malformedConfigResponse = (error: unknown): boolean =>
  error instanceof Error && /Malformed .* upstream config/.test(error.message);

// Draft previews are deliberately detached from storage. The request carries
// the exact editor values to probe, and neither a matching id nor matching
// credentials can turn this operation into a cache write.
export const previewModels = async (c: CtxWithJson<typeof previewModelsBody>) => {
  const { record } = c.req.valid('json');
  if (!isValidProviderKind(record.kind)) {
    return c.json({ error: { message: `Invalid kind: ${record.kind}`, type: 'invalid_request_error' } }, 400);
  }
  const kind = record.kind;
  const proxyFallbackList = (record.proxy_fallback_list ?? []) as ProxyFallbackEntry[];

  const now = new Date().toISOString();
  const synthRecord: UpstreamRecord = {
    id: 'draft',
    kind,
    name: 'draft',
    enabled: true,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList,
    modelPrefix: null,
    // A draft only lists models; nothing renders its badge.
    hue: 0,
    config: record.config,
    state: record.state,
    // A draft is built from the request envelope and lists models live, so it
    // never carries a cached catalog.
    modelsCache: null,
  };
  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({
      override: proxyFallbackList,
      runtimeLocation: getRuntimeLocation(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  try {
    if (kind === 'custom') {
      const assertedConfig = assertCustomUpstreamRecord(synthRecord).config;
      const result = await fetchCustomModels(assertedConfig, fetcher);
      return c.json({ data: projectCustomDiscoveredModels(synthRecord, result) });
    }
    const models = await createPreviewProvider(synthRecord).instance.getProvidedModels(fetcher);
    return c.json({ data: models.map(reshapeModelForDashboard) });
  } catch (e) {
    if (e instanceof ProviderModelsUnavailableError) {
      return c.json({ error: { message: MODEL_LISTING_FAILURE_MESSAGE, type: 'api_error', code: MODEL_LISTING_FAILURE_CODE } }, 502);
    }
    if (malformedConfigResponse(e)) {
      return c.json({ error: errorMessage(e) }, 400);
    }
    throw e;
  }
};

// Saved refreshes accept only an id, then read the current config and version
// from storage. A stale editor cannot publish a draft under the saved row.
export const fetchSavedModels = async (c: AuthedContext<'/:id/list-models'>) => {
  const id = c.req.param('id');
  const record = await getRepo().upstreams.getById(id);
  if (record === null) return c.json({ error: 'Upstream not found' }, 404);

  let fetcher: Fetcher;
  try {
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxyFallbackList,
      upstreamId: id,
      runtimeLocation: getRuntimeLocation(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  try {
    let data: UpstreamModelConfig[];
    if (record.kind === 'custom') {
      const config = assertCustomUpstreamRecord(record).config;
      const result = await fetchCustomModels(config, fetcher);
      await fetchUpstreamModels(createProvider(record), fetcher, async () => projectCustomModels(record, result));
      data = projectCustomDiscoveredModels(record, result);
    } else {
      data = (await fetchUpstreamModels(createProvider(record), fetcher)).map(reshapeModelForDashboard);
    }
    const refreshed = await getRepo().upstreams.getById(id);
    if (refreshed === null) throw new Error(`Upstream ${id} disappeared after models refresh`);
    return c.json({ data, modelsCache: modelsCacheStatus(refreshed) });
  } catch (e) {
    if (e instanceof ProviderModelsUnavailableError) {
      return c.json({ error: { message: MODEL_LISTING_FAILURE_MESSAGE, type: 'api_error', code: MODEL_LISTING_FAILURE_CODE } }, 502);
    }
    if (malformedConfigResponse(e)) return c.json({ error: errorMessage(e) }, 400);
    throw e;
  }
};
