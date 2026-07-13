import type { ModelAliasesRepo } from '../../repo/types.ts';
import { enumerateAddressableModelIds, listedRealModels } from '../shared/listing/addressable.ts';
import { mergeAliasesIntoModels } from '../shared/listing/alias.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { PublicModel, PublicModelsResponse } from '@floway-dev/protocols/common';
import type { Fetcher, InternalModel } from '@floway-dev/provider';

// Project an `InternalModel` onto the public-facing `/v1/models` wire DTO.
// `endpoints` rides through so listing clients can introspect each model's
// reach without a per-endpoint probe. When the row is an alias-synthesized
// one, `aliasedFrom` is emitted verbatim from the internal shape (they
// share the same fields); the real branch never carries it, so the sidecar
// is present exactly on alias rows.
export const toPublicModel = (model: InternalModel): PublicModel => {
  const info: PublicModel = {
    id: model.id,
    object: 'model',
    type: 'model',
    display_name: model.display_name ?? model.id,
    limits: { ...model.limits },
    kind: model.kind,
    endpoints: { ...model.endpoints },
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
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
  aliasRepo: ModelAliasesRepo,
): Promise<PublicModelsResponse> => {
  // Data-plane responses always narrow `aliasedFrom.targets` to the
  // caller's reachable set (and never expose typo'd / removed target
  // ids), but the alias's metadata is still computed gateway-wide so
  // every caller sees the same numbers.
  const [callerAddressable, gatewayAddressable, aliases] = await Promise.all([
    enumerateAddressableModelIds(upstreamFilter, fetcherForUpstream, scheduler),
    upstreamFilter === null
      ? Promise.resolve(null)
      : enumerateAddressableModelIds(null, fetcherForUpstream, scheduler),
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
