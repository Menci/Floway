import type { Context } from 'hono';

import { toPublicModel } from '../../data-plane/models/load.ts';
import { ProviderModelsUnavailableError } from '../../data-plane/providers/models-store.ts';
import { getModels } from '../../data-plane/providers/registry.ts';
import type { ResolvedModel } from '../../data-plane/providers/types.ts';
import type { UpstreamProviderKind } from '../../repo/types.ts';
import type { PublicModel, PublicModelsResponse } from '@floway-dev/protocols/common';

// Same DTO as the public /models endpoint, plus one dashboard-only field:
// `upstreams` lists every provider binding for this model as { kind, id, name }
// triples so the picker can group, the upstream rows can count their bound
// models, and the chat panel can render each providing upstream as a labeled
// badge without re-fetching the admin-only /api/upstreams endpoint (non-admin
// users can see the models tab). A single model id can be served by mixed
// provider kinds (e.g. one azure deployment + one custom upstream both expose
// `gpt-5.5`), so a flat `provider`/`upstream_ids` split would misrepresent
// that.
interface ControlPlaneModel extends PublicModel {
  upstreams: { kind: UpstreamProviderKind; id: string; name: string }[];
}

interface ControlPlaneModelsResponse extends Omit<PublicModelsResponse, 'data'> {
  data: ControlPlaneModel[];
}

const toControlPlaneModel = (model: ResolvedModel): ControlPlaneModel => ({
  ...toPublicModel(model),
  upstreams: model.providers.map(binding => ({ kind: binding.providerKind, id: binding.upstream, name: binding.upstreamName })),
});

const modelListingFailureMessage = 'Upstream model listing failed';

const emptyResponse = (): ControlPlaneModelsResponse => ({
  object: 'list',
  has_more: false,
  first_id: null,
  last_id: null,
  data: [],
});

export const controlPlaneModels = async (c: Context) => {
  try {
    const models = await getModels();
    const data = models.map(toControlPlaneModel);
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
      return c.json(emptyResponse());
    }
    // Genuine upstream HTTP/parse failures are squashed to a generic 502 so
    // the control plane does not leak provider identity.
    if (e instanceof ProviderModelsUnavailableError) {
      return c.json({ error: { message: modelListingFailureMessage, type: 'api_error' } }, 502);
    }
    return c.json({ error: { message: e instanceof Error ? e.message : String(e), type: 'api_error' } }, 502);
  }
};
