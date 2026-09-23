import { modelsCacheStatus } from './models-cache-status.ts';
import { upstreamErrorMessage as errorMessage } from './shared.ts';
import type { ListedUpstreamModel } from './types.ts';
import { discoverDraftModels, isModelsRefreshConfigurationError, modelsRefreshErrorMessage, modelsRefreshTarget, refreshModelsExplicit } from '../../execution/models-refresh.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { previewModelsBody } from '../schemas.ts';
import { ProviderModelsUnavailableError, type ProviderModel, type UpstreamRecord } from '@floway-dev/provider';

const MODEL_LISTING_FAILURE_CODE = 'upstream_model_listing_failed';

const reshapeModelForDashboard = (model: ProviderModel): ListedUpstreamModel => ({
  upstreamModelId: model.upstreamModelId,
  publicModelId: model.id,
  kind: model.kind,
  endpoints: model.endpoints,
  ...(model.display_name !== undefined ? { display_name: model.display_name } : {}),
  ...(Object.keys(model.limits).length > 0 ? { limits: model.limits } : {}),
  ...(model.pricing ? { pricing: model.pricing } : {}),
  ...(model.chat ? { chat: model.chat } : {}),
  opaqueBlobCompatibilityScope: model.opaqueBlobCompatibilityScope,
  ...(model.flagOverrides ? { flagOverrides: model.flagOverrides } : {}),
});

const malformedConfigResponse = (error: unknown): boolean =>
  error instanceof Error && /Malformed .* upstream config/.test(error.message);

// A draft never reads or writes its upstream row. Proxy resolution can still
// access proxy records and backoff state; matching a saved id cannot publish
// the draft's model catalog.
export const previewModels = async (c: CtxWithJson<typeof previewModelsBody>) => {
  const { record } = c.req.valid('json');
  const kind = record.kind;
  if (kind !== 'custom' && kind !== 'ollama') {
    return c.json({ error: { message: `Draft model discovery requires custom or ollama: ${kind}`, type: 'invalid_request_error' } }, 400);
  }
  const synthRecord: UpstreamRecord = {
    id: record.id || 'draft',
    kind,
    name: record.name ?? 'draft',
    enabled: record.enabled ?? true,
    sortOrder: record.sort_order ?? 0,
    createdAt: record.created_at ?? '',
    updatedAt: record.updated_at ?? '',
    flagOverrides: record.flag_overrides ?? {},
    disabledPublicModelIds: record.disabled_public_model_ids ?? [],
    proxyFallbackList: record.proxy_fallback_list,
    modelPrefix: record.model_prefix ?? null,
    hue: record.hue ?? 0,
    config: record.config,
    state: record.state,
    modelsCache: null,
  };
  try {
    const result = await discoverDraftModels(synthRecord, getRuntimeLocation(c.req.raw));
    if (result.kind !== 'discovered') throw new Error('Draft discovery did not run');
    const data = kind === 'custom' ? result.discovered : result.models.map(reshapeModelForDashboard);
    if (data === undefined) throw new Error('Custom draft discovery did not return a catalog');
    return c.json({ kind, data });
  } catch (e) {
    if (e instanceof ProviderModelsUnavailableError) {
      return c.json({ error: { message: modelsRefreshErrorMessage(e), type: 'api_error', code: MODEL_LISTING_FAILURE_CODE, upstreamResponse: e.displayResponse } }, 502);
    }
    if (malformedConfigResponse(e) || isModelsRefreshConfigurationError(e)) {
      return c.json({ error: errorMessage(e) }, 400);
    }
    throw e;
  }
};

// The route pins the version; the cell loads the authoritative row and rejects
// an edit that wins before discovery begins.
export const fetchSavedModels = async (c: AuthedContext<'/:id/list-models'>) => {
  const id = c.req.param('id');
  const record = await getRepo().upstreams.getById(id);
  if (record === null) return c.json({ error: 'Upstream not found' }, 404);
  const target = modelsRefreshTarget(record);
  const runtimeLocation = getRuntimeLocation(c.req.raw);

  try {
    const result = await refreshModelsExplicit(target, runtimeLocation);
    if (result.kind !== 'discovered') return c.json({ error: 'Upstream changed during models refresh' }, 409);
    const refreshed = await getRepo().upstreams.getById(id);
    if (refreshed === null || modelsRefreshTarget(refreshed).inputHash !== target.inputHash
      || refreshed.configVersion !== target.configVersion) return c.json({ error: 'Upstream changed during models refresh' }, 409);
    const data = record.kind === 'custom' ? result.discovered : result.models.map(reshapeModelForDashboard);
    if (data === undefined) throw new Error(`Upstream ${id} models refresh did not return a catalog`);
    return c.json({ kind: record.kind, data, modelsCache: modelsCacheStatus(refreshed) });
  } catch (e) {
    if (!(e instanceof ProviderModelsUnavailableError) && !isModelsRefreshConfigurationError(e) && !malformedConfigResponse(e)) throw e;
    const afterFailure = await getRepo().upstreams.getById(id);
    if (afterFailure === null || modelsRefreshTarget(afterFailure).inputHash !== target.inputHash
      || afterFailure.configVersion !== target.configVersion) return c.json({ error: 'Upstream changed during models refresh' }, 409);
    if (e instanceof ProviderModelsUnavailableError) {
      return c.json({
        error: { message: modelsRefreshErrorMessage(e), type: 'api_error', code: MODEL_LISTING_FAILURE_CODE, upstreamResponse: e.displayResponse },
        modelsCache: modelsCacheStatus(afterFailure),
      }, 502);
    }
    return c.json({ error: errorMessage(e) }, 400);
  }
};
