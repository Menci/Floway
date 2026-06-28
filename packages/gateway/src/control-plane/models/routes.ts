import type { Context } from 'hono';

import { toPublicModel } from '../../data-plane/models/load.ts';
import { MODEL_LISTING_FAILURE_MESSAGE } from '../../data-plane/models/shared.ts';
import { getModels } from '../../data-plane/providers/registry.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getCurrentColo } from '../../runtime/runtime-info.ts';
import type { PublicModel, PublicModelsResponse } from '@floway-dev/protocols/common';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';
import type { InternalModel, ModelProviderInstance, UpstreamProviderKind } from '@floway-dev/provider';

// Same DTO as the public /models endpoint, plus one dashboard-only field:
// `upstreams` lists every upstream that surfaces this model as { kind, id, name }
// triples. A single model id can be served by mixed provider kinds (e.g. one
// azure deployment + one custom upstream both expose `gpt-5.5`), so a flat
// `provider`/`upstream_ids` split would misrepresent that.
interface ControlPlaneModel extends PublicModel {
  upstreams: { kind: UpstreamProviderKind; id: string; name: string }[];
}

interface ControlPlaneModelsResponse extends Omit<PublicModelsResponse, 'data'> {
  data: ControlPlaneModel[];
}

const toControlPlaneModel = (model: InternalModel, instances: readonly ModelProviderInstance[]): ControlPlaneModel => ({
  ...toPublicModel(model),
  upstreams: instances.map(instance => ({ kind: instance.providerKind, id: instance.upstream, name: instance.name })),
});

export const controlPlaneModels = async (c: Context) => {
  try {
    // Scope the dashboard catalog to the caller's effective upstreams, exactly
    // like the data-plane /models endpoint. On a session request there is no
    // API key, so this resolves to the user's per-user upstream cap: a user who
    // has had an upstream removed must not see its models in the Models tab.
    const fetcherForUpstream = await createPerRequestFetcher(getCurrentColo(c.req.raw));
    const { models, upstreamsByPublicId } = await getModels(effectiveUpstreamIdsFromContext(c), fetcherForUpstream, backgroundSchedulerFromContext(c));
    const data = models.map(model => toControlPlaneModel(model, upstreamsByPublicId.get(model.id) ?? []));
    const response: ControlPlaneModelsResponse = {
      object: 'list',
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
      data,
    };
    return c.json(response);
  } catch (e: unknown) {
    // Empty-upstreams is a domain state, not an error, on the dashboard. The
    // public /v1/models endpoint still surfaces it as a 502 to remote clients
    // because they need to know the gateway is unconfigured — but the
    // dashboard's Models tab should render an empty grid + the operator
    // guidance message inline instead of flashing a 502 in devtools.
    if (e instanceof Error && e.message.startsWith('No upstream provider configured')) {
      return c.json({ object: 'list', has_more: false, first_id: null, last_id: null, data: [] });
    }
    // Genuine upstream HTTP/parse failures are squashed to a generic 502 so
    // the control plane does not leak provider identity.
    if (e instanceof ProviderModelsUnavailableError) {
      return c.json({ error: { message: MODEL_LISTING_FAILURE_MESSAGE, type: 'api_error' } }, 502);
    }
    return c.json({ error: { message: e instanceof Error ? e.message : String(e), type: 'api_error' } }, 502);
  }
};
