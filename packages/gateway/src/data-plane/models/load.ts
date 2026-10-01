import type { ModelsRefreshScheduler } from '../../execution/models-refresh.ts';
import type { ModelAliasesRepo } from '../../repo/types.ts';
import { downstreamEndpointsFor } from '../providers/downstream-endpoints.ts';
import { enumerateAddressableModelIds, listedRealModels } from '../shared/listing/addressable.ts';
import { mergeAliasesIntoModels } from '../shared/listing/alias.ts';
import type { PublicModel, PublicModelsResponse } from '@floway-dev/protocols/common';
import type { InternalModel } from '@floway-dev/provider';

// The public endpoint map describes the client-facing surface after translation.
export const toPublicModel = (model: InternalModel): PublicModel => {
  const info: PublicModel = {
    id: model.id,
    object: 'model',
    type: 'model',
    display_name: model.display_name ?? model.id,
    limits: { ...model.limits },
    kind: model.kind,
    endpoints: { ...(model.downstreamEndpoints ?? downstreamEndpointsFor(model.endpoints)) },
    opaqueBlobCompatibilityScope: model.opaqueBlobCompatibilityScope ?? { bindToUpstream: true },
  };
  if (model.owned_by !== undefined) info.owned_by = model.owned_by;
  if (model.created !== undefined) {
    info.created = model.created;
    info.created_at = new Date(model.created * 1000).toISOString();
  }
  if (model.pricing) info.pricing = model.pricing;
  if (model.chat) info.chat = model.chat;
  if (model.aliasedFrom !== undefined) {
    info.aliasedFrom = {
      selection: model.aliasedFrom.selection,
      targets: [...model.aliasedFrom.targets],
    };
  }
  return info;
};

export const loadModels = async (
  upstreamFilter: readonly string[] | null,
  scheduleRefresh: ModelsRefreshScheduler,
  aliasRepo: ModelAliasesRepo,
): Promise<PublicModelsResponse> => {
  // Data-plane responses always narrow `aliasedFrom.targets` to the
  // caller's reachable set (and never expose typo'd / removed target
  // ids), but the alias's metadata is still computed gateway-wide so
  // every caller sees the same numbers.
  const [callerAddressable, gatewayAddressable, aliases] = await Promise.all([
    enumerateAddressableModelIds(upstreamFilter, scheduleRefresh),
    upstreamFilter === null
      ? Promise.resolve(null)
      : enumerateAddressableModelIds(null, scheduleRefresh),
    aliasRepo.list(),
  ]);
  const gatewayAddressableModelIds = gatewayAddressable ?? callerAddressable;
  const realModels = listedRealModels(callerAddressable);
  const merged = mergeAliasesIntoModels({
    realModels,
    gatewayAddressableModelIds,
    callerAddressableModelIds: callerAddressable,
    aliases,
    narrowTargets: true,
  });
  const data = merged.map(toPublicModel);
  return {
    object: 'list',
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    data,
  };
};
