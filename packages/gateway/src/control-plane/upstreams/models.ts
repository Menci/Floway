import { modelsCacheStatus, reshapeModelForDashboard } from './models-cache-projection.ts';
import { upstreamErrorMessage as errorMessage } from './shared.ts';
import { fullUpstreamActionError, resolveUpstreamEditLevel } from '../../access-control/upstream-edit.ts';
import { discoverDraftModels, isModelsRefreshConfigurationError, modelsRefreshErrorMessage, refreshModelsExplicit } from '../../execution/models-refresh.ts';
import { type AuthedContext, userFromContext } from '../../middleware/auth.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { previewModelsBody } from '../schemas.ts';
import { isRecord } from '../shared/field-validators.ts';
import { ProviderModelsUnavailableError, type UpstreamModelConfig, type UpstreamRecord } from '@floway-dev/provider';
import { validateCustomManualModels } from '@floway-dev/provider-custom';
import { validateOllamaManualModels } from '@floway-dev/provider-ollama';

const MODEL_LISTING_FAILURE_CODE = 'upstream_model_listing_failed';

const malformedConfigResponse = (error: unknown): boolean =>
  error instanceof Error && /Malformed .* upstream config/.test(error.message);

const splitDraftConfigAndManualModels = (
  kind: 'custom' | 'ollama' | 'kimi-code',
  rawConfig: unknown,
): { readonly config: unknown; readonly manualModels: UpstreamModelConfig[] } => {
  if (kind === 'kimi-code' || !isRecord(rawConfig)) {
    return { config: rawConfig, manualModels: [] };
  }
  const { models, ...rest } = rawConfig;
  const manualModels = kind === 'custom'
    ? validateCustomManualModels(models)
    : validateOllamaManualModels(models);
  return { config: rest, manualModels };
};

// A draft never reads or writes its upstream row or that row's proxy backoff
// state; matching a saved id cannot publish the draft's model catalog.
export const previewModels = async (c: CtxWithJson<typeof previewModelsBody>) => {
  const { record } = c.req.valid('json');
  const accessError = await fullUpstreamActionError(userFromContext(c), record.id);
  if (accessError) return c.json({ error: accessError.error }, accessError.status);
  const kind = record.kind;
  if (kind !== 'custom' && kind !== 'ollama' && kind !== 'kimi-code') {
    return c.json({ error: { message: `Draft model discovery requires custom, ollama or kimi-code: ${kind}`, type: 'invalid_request_error' } }, 400);
  }
  let config: unknown;
  let manualModels: UpstreamModelConfig[];
  try {
    ({ config, manualModels } = splitDraftConfigAndManualModels(kind, record.config));
  } catch (e) {
    if (malformedConfigResponse(e)) return c.json({ error: errorMessage(e) }, 400);
    throw e;
  }
  const synthRecord: UpstreamRecord = {
    id: record.id,
    kind,
    name: record.name ?? 'draft',
    enabled: record.enabled ?? true,
    usageRefreshIntervalMinutes: record.usage_refresh_interval_minutes ?? 0,
    sortOrder: record.sort_order ?? 0,
    createdAt: record.created_at ?? '',
    updatedAt: record.updated_at ?? '',
    flagOverrides: record.flag_overrides ?? {},
    disabledPublicModelIds: record.disabled_public_model_ids ?? [],
    proxyFallbackList: record.proxy_fallback_list,
    modelPrefix: record.model_prefix ?? null,
    hue: record.hue ?? 0,
    config,
    state: record.state,
  };
  try {
    const result = await discoverDraftModels(synthRecord, manualModels, getRuntimeLocation(c.req.raw));
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

export const fetchSavedModels = async (c: AuthedContext<'/:id/list-models'>) => {
  const id = c.req.param('id');
  if (await resolveUpstreamEditLevel(userFromContext(c), id) === 'off') {
    return c.json({ error: 'Upstream not found' }, 404);
  }
  const repo = getRepo();
  const record = await repo.upstreams.getById(id);
  if (record === null) return c.json({ error: 'Upstream not found' }, 404);
  const target = { upstreamId: record.id, configVersion: record.configVersion };
  const runtimeLocation = getRuntimeLocation(c.req.raw);

  try {
    const result = await refreshModelsExplicit(target, runtimeLocation);
    if (result.kind !== 'discovered') return c.json({ error: 'Upstream changed during models refresh' }, 409);
    const [refreshed, counts] = await Promise.all([
      repo.upstreams.getById(id),
      repo.upstreamModels.countListedByUpstream([id]),
    ]);
    if (refreshed === null || refreshed.configVersion !== target.configVersion) {
      return c.json({ error: 'Upstream changed during models refresh' }, 409);
    }
    const data = record.kind === 'custom' ? result.discovered : result.models.map(reshapeModelForDashboard);
    if (data === undefined) throw new Error(`Upstream ${id} models refresh did not return a catalog`);
    return c.json({ kind: record.kind, data, modelsCache: modelsCacheStatus(refreshed, counts.get(id) ?? null) });
  } catch (e) {
    if (!(e instanceof ProviderModelsUnavailableError) && !isModelsRefreshConfigurationError(e) && !malformedConfigResponse(e)) throw e;
    const [afterFailure, counts] = await Promise.all([
      repo.upstreams.getById(id),
      repo.upstreamModels.countListedByUpstream([id]),
    ]);
    if (afterFailure === null || afterFailure.configVersion !== target.configVersion) {
      return c.json({ error: 'Upstream changed during models refresh' }, 409);
    }
    if (e instanceof ProviderModelsUnavailableError) {
      return c.json({
        error: { message: modelsRefreshErrorMessage(e), type: 'api_error', code: MODEL_LISTING_FAILURE_CODE, upstreamResponse: e.displayResponse },
        modelsCache: modelsCacheStatus(afterFailure, counts.get(id) ?? null),
      }, 502);
    }
    return c.json({ error: errorMessage(e) }, 400);
  }
};
