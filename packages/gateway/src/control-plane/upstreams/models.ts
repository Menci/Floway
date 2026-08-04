import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { isValidProviderKind, upstreamErrorMessage as errorMessage } from './shared.ts';
import type { ListedUpstreamModel } from './types.ts';
import { MODEL_LISTING_FAILURE_CODE, MODEL_LISTING_FAILURE_MESSAGE } from '../../data-plane/models/shared.ts';
import { fetchUpstreamModelsCached } from '../../data-plane/providers/models-cache.ts';
import { createProvider } from '../../data-plane/providers/registry.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
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
      const provider = createProvider(synthRecord);
      let result: Awaited<ReturnType<typeof fetchCustomModels>> | undefined;
      if (record.id === '') {
        result = await fetchCustomModels(assertedConfig, fetcher);
      } else {
        await fetchUpstreamModelsCached(provider, {
          scheduler,
          fetcher,
          force: true,
          loadProvidedModels: async () => {
            result = await fetchCustomModels(assertedConfig, fetcher);
            return projectCustomModels(synthRecord, result);
          },
        });
        // A concurrent refresh may already own the cache's in-flight slot, in
        // which case our raw-shape loader was not invoked. The dashboard still
        // needs its raw response, so only that joined-flight case fetches it
        // separately.
        result ??= await fetchCustomModels(assertedConfig, fetcher);
      }
      return c.json({ kind, data: result.data });
    }
    // Copilot / codex / claude-code / azure / ollama — use the provider factory.
    // Force through the SWR cache when the record is persisted so the
    // side-effect refresh keeps the data-plane cache in step; otherwise
    // live-fetch without any caching.
    const provider = createProvider(synthRecord);
    const models = record.id !== ''
      ? await fetchUpstreamModelsCached(provider, { scheduler, fetcher, force: true })
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
