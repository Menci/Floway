import { modelsCacheStatus, reshapeModelForDashboard } from './models-cache-projection.ts';
import { upstreamErrorMessage as errorMessage } from './shared.ts';
import { resolveUpstreamEditLevel } from '../../access-control/upstream-edit.ts';
import { type AuthedContext, userFromContext } from '../../middleware/auth.ts';
import { getRepo } from '../../repo/index.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import { isModelsRefreshConfigurationError, modelsRefreshErrorMessage, refreshModelsExplicit } from '../../upstreams/models-refresh.ts';
import { UpstreamModelsUnavailableError } from '@floway-dev/upstream';

const MODEL_LISTING_FAILURE_CODE = 'upstream_model_listing_failed';

const malformedConfigResponse = (error: unknown): boolean =>
  error instanceof Error && /Malformed .* upstream config/.test(error.message);

export const fetchSavedModels = async (c: AuthedContext<'/:id/list-models'>) => {
  const id = c.req.param('id');
  if (await resolveUpstreamEditLevel(userFromContext(c), id) === 'off') {
    return c.json({ error: 'Upstream not found' }, 404);
  }
  const repo = getRepo();
  const record = await repo.upstreams.getById(id);
  if (record === null) return c.json({ error: 'Upstream not found' }, 404);
  const target = { upstreamId: record.id, version: record.version };
  const runtimeLocation = getRuntimeLocation(c.req.raw);

  try {
    const result = await refreshModelsExplicit(target, runtimeLocation);
    if (result.kind !== 'discovered' || result.publication === 'lost-race') {
      return c.json({ error: 'Upstream changed during models refresh' }, 409);
    }
    const [refreshed, counts] = await Promise.all([
      repo.upstreams.getById(id),
      repo.upstreamModels.countListedByUpstream([id]),
    ]);
    if (refreshed?.version !== result.version) {
      return c.json({ error: 'Upstream changed during models refresh' }, 409);
    }
    const data = result.entries
      .filter(entry => entry.source === 'auto')
      .map(entry => reshapeModelForDashboard(entry.model));
    return c.json({ kind: record.kind, data, modelsCache: modelsCacheStatus(refreshed, counts.get(id) ?? null) });
  } catch (e) {
    if (!(e instanceof UpstreamModelsUnavailableError) && !isModelsRefreshConfigurationError(e) && !malformedConfigResponse(e)) throw e;
    const [afterFailure, counts] = await Promise.all([
      repo.upstreams.getById(id),
      repo.upstreamModels.countListedByUpstream([id]),
    ]);
    if (afterFailure === null || afterFailure.version !== target.version) {
      return c.json({ error: 'Upstream changed during models refresh' }, 409);
    }
    if (e instanceof UpstreamModelsUnavailableError) {
      return c.json({
        error: { message: modelsRefreshErrorMessage(e), type: 'api_error', code: MODEL_LISTING_FAILURE_CODE, upstreamResponse: e.displayResponse },
        modelsCache: modelsCacheStatus(afterFailure, counts.get(id) ?? null),
      }, 502);
    }
    return c.json({ error: errorMessage(e), modelsCache: modelsCacheStatus(afterFailure, counts.get(id) ?? null) }, 400);
  }
};
