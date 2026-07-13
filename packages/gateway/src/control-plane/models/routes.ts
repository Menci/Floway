import type { Context } from 'hono';

import { toPublicModel } from '../../data-plane/models/load.ts';
import { MODEL_LISTING_FAILURE_MESSAGE } from '../../data-plane/models/shared.ts';
import { type AddressableIdEntry, enumerateAddressableModelIds, listedRealModels } from '../../data-plane/shared/listing/addressable.ts';
import { mergeAliasesIntoModels } from '../../data-plane/shared/listing/alias.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { effectiveUpstreamIdsFromContext, userFromContext } from '../../middleware/auth.ts';
import { getRepo } from '../../repo/index.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { PublicModel, PublicModelsResponse } from '@floway-dev/protocols/common';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';
import type { InternalModel, Provider, UpstreamColor, UpstreamProviderKind } from '@floway-dev/provider';

// Same DTO as the public /models endpoint, plus one dashboard-only field:
// `upstreams` lists every upstream that surfaces this model as { kind, id, name, color }
// tuples. A single model id can be served by mixed provider kinds (e.g. one
// azure deployment + one custom upstream both expose `gpt-5.5`), so a flat
// `provider`/`upstream_ids` split would misrepresent that. Alias-synthesized
// rows carry an empty list — they do not bind to an upstream directly; their
// targets live under `aliasedFrom`. `color` is the per-upstream override the
// dashboard uses to paint each chip; `null` inherits the kind default.
interface ControlPlaneModel extends PublicModel {
  upstreams: { kind: UpstreamProviderKind; id: string; name: string; color: UpstreamColor | null }[];
}

interface ControlPlaneModelsResponse extends Omit<PublicModelsResponse, 'data'> {
  data: ControlPlaneModel[];
}

const toControlPlaneModel = (
  model: InternalModel,
  instances: readonly Provider[],
  colorByUpstream: ReadonlyMap<string, UpstreamColor | null>,
): ControlPlaneModel => ({
  ...toPublicModel(model),
  upstreams: instances.map(instance => ({
    kind: instance.kind,
    id: instance.upstream,
    name: instance.name,
    color: colorByUpstream.get(instance.upstream) ?? null,
  })),
});

// Wrap an addressable-but-not-listed entry as a control-plane row. The
// canonical metadata (`limits`, `chat`, `endpoints`, `upstreams`) reads
// off the real model the addressable id resolves to; only `id` and
// `display_name` swap in the addressable form so the alias dialog
// combobox renders the actual id the operator can type. `unlisted: true`
// carries the addressability tag through to the dashboard so a future UI
// badge does not need a second registry call.
const toUnlistedControlPlaneModel = (
  entry: AddressableIdEntry,
  colorByUpstream: ReadonlyMap<string, UpstreamColor | null>,
): ControlPlaneModel => ({
  ...toControlPlaneModel(entry.model, entry.upstreams, colorByUpstream),
  id: entry.id,
  display_name: entry.model.display_name ?? entry.id,
  unlisted: true,
});

export const controlPlaneModels = async (c: Context) => {
  try {
    const includeAliases = c.req.query('aliases') !== 'false';
    const includeUnlisted = c.req.query('include_unlisted') === 'true';
    // Admin sessions see the entire gateway: editor surfaces (alias edit,
    // upstream edit) need to configure models on upstreams the admin may
    // have self-restricted out of their own data-plane access, and the
    // dashboard filters the result client-side for surfaces that should
    // respect the restriction (Models page, playground). Non-admin
    // sessions stay scoped to their effective upstream cap so the
    // dashboard cannot leak models from upstreams their account has no
    // data-plane access to.
    const isAdmin = userFromContext(c).isAdmin;
    const upstreamScope = isAdmin ? null : effectiveUpstreamIdsFromContext(c);
    // Fetch the upstream list once at the request boundary and thread it
    // into every downstream consumer (`createPerRequestFetcher`,
    // `enumerateAddressableModelIds`, the color-join map) so this request
    // pays a single `upstreams.list()` round-trip.
    const upstreamRows = await getRepo().upstreams.list();
    const fetcherForUpstream = await createPerRequestFetcher(getRuntimeLocation(c.req.raw), upstreamRows);
    // Two addressable surfaces: caller-scoped (drives visibility +
    // `aliasedFrom.targets` narrowing for non-admin) and gateway-wide
    // (drives the alias's metadata + endpoints + pricing — every caller
    // sees the same numbers for the same alias). For admin the two are
    // the same, so skip the second fetch.
    const [callerAddressable, gatewayAddressable, aliases] = await Promise.all([
      enumerateAddressableModelIds(upstreamScope, fetcherForUpstream, backgroundSchedulerFromContext(c), upstreamRows),
      isAdmin
        ? Promise.resolve(null)
        : enumerateAddressableModelIds(null, fetcherForUpstream, backgroundSchedulerFromContext(c), upstreamRows),
      includeAliases ? getRepo().modelAliases.list() : Promise.resolve([]),
    ]);
    const colorByUpstream = new Map<string, UpstreamColor | null>(upstreamRows.map(row => [row.id, row.color]));
    const gatewayAddressableModelIds = gatewayAddressable ?? callerAddressable;
    const upstreamsByListedId = new Map(callerAddressable.map(entry => [entry.id, entry.upstreams] as const));
    const realModels = listedRealModels(callerAddressable);
    const merged = includeAliases
      ? mergeAliasesIntoModels({
          realModels,
          gatewayAddressableModelIds,
          callerAddressableModelIds: callerAddressable,
          aliases,
          // Admin sees raw configured targets (including typos / out-of-
          // cap models) so the alias-edit dialog can render the full
          // configuration; non-admin sessions get the narrowed projection.
          narrowTargets: !isAdmin,
        })
      : realModels;
    // Alias-synthesized rows never bind to an upstream — hand an empty
    // list; real rows read the reverse index built from `callerAddressable`.
    const listedRows = merged.map(model => toControlPlaneModel(
      model,
      model.aliasedFrom !== undefined ? [] : (upstreamsByListedId.get(model.id) ?? []),
      colorByUpstream,
    ));
    // Dedupe the unlisted half against the listed half on `id` — an alias
    // whose name coincides with an addressable-but-not-listed id (e.g. a
    // Copilot variant) would otherwise emit two rows with the same id but
    // different `unlisted` flags. /v1/models already collapses this kind
    // of collision; the dashboard must agree.
    const listedIds = new Set(listedRows.map(row => row.id));
    const unlistedRows = includeUnlisted
      ? callerAddressable
          .filter(entry => entry.unlisted === true && !listedIds.has(entry.id))
          .map(entry => toUnlistedControlPlaneModel(entry, colorByUpstream))
      : [];
    const data = [...listedRows, ...unlistedRows];
    const response: ControlPlaneModelsResponse = {
      object: 'list',
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
      data,
    };
    return c.json(response);
  } catch (e: unknown) {
    // Empty-upstreams is a domain state, not an error, on the dashboard:
    // /v1/models still surfaces it as a 502 (remote clients need to know
    // the gateway is unconfigured), but the Models tab renders an empty
    // grid inline.
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
