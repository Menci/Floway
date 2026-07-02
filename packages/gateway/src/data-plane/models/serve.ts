// OpenAI and Anthropic /models field names do not overlap, so one payload
// satisfies both client shapes.

import type { Context } from 'hono';

import { loadModels } from './load.ts';
import { MODEL_LISTING_FAILURE_MESSAGE } from './shared.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { getRepo } from '../../repo/index.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getCurrentColo } from '../../runtime/runtime-info.ts';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';

export const models = async (c: Context) => {
  try {
    const fetcherForUpstream = await createPerRequestFetcher(getCurrentColo(c.req.raw));
    return Response.json(await loadModels(effectiveUpstreamIdsFromContext(c), fetcherForUpstream, backgroundSchedulerFromContext(c), getRepo().modelAliases));
  } catch (e) {
    // Upstream HTTP/parse failures squash to a generic message so we do not
    // leak upstream identity. Other registry-thrown errors (e.g. the "no
    // upstream configured" hint) carry actionable operator guidance and
    // surface verbatim with the same 502.
    const message = e instanceof ProviderModelsUnavailableError
      ? MODEL_LISTING_FAILURE_MESSAGE
      : (e instanceof Error ? e.message : String(e));
    return Response.json({ error: { message, type: 'api_error' } }, { status: 502 });
  }
};
