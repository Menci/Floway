import type { ModelAliasesRepo, User } from '../../repo/types.ts';
import { listedRealModels, loadAddressableSurfaces, type AddressableIdEntry } from '../shared/listing/addressable.ts';
import { mergeAliasesIntoModels } from '../shared/listing/alias.ts';
import type { PublicModel, PublicModelsResponse } from '@floway-dev/protocols/common';
import type { InternalModel } from '@floway-dev/upstream';

// Project an `InternalModel` onto the public-facing `/v1/models` wire DTO.
// `endpoints` rides through as the merged upstream wire surface — the
// endpoints the upstreams serve this model on, not the inbound routes a
// client may call. Translation widens the chat keys: any one of
// `openaiChatCompletions` / `anthropicMessages` / `openaiResponses` / `geminiGenerateContent`
// makes the model reachable from all four inbound chat routes.
// When the row is an alias-synthesized one, `aliasedFrom` is emitted verbatim
// from the internal shape (they share the same fields); the real branch never
// carries it, so the sidecar is present exactly on alias rows.
export const toPublicModel = (model: InternalModel): PublicModel => {
  const info: PublicModel = {
    id: model.id,
    object: 'model',
    type: 'model',
    display_name: model.display_name ?? model.id,
    limits: { ...model.limits },
    kind: model.kind,
    endpoints: { ...model.endpoints },
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

export interface ModelListingCatalog {
  readonly callerAddressable: readonly AddressableIdEntry[];
  readonly gatewayAddressable: readonly AddressableIdEntry[];
  readonly realModels: readonly InternalModel[];
  readonly aliases: Awaited<ReturnType<ModelAliasesRepo['list']>>;
}

export const loadModelListingCatalog = async (
  subject: User,
  upstreamFilter: readonly string[] | null,
  aliasRepo: ModelAliasesRepo,
): Promise<ModelListingCatalog> => {
  const { callerAddressable, gatewayAddressable, aliases } = await loadAddressableSurfaces(
    subject,
    upstreamFilter,
    aliasRepo.list(),
  );
  return {
    callerAddressable,
    gatewayAddressable,
    realModels: listedRealModels(callerAddressable),
    aliases,
  };
};

export const loadModels = async (
  subject: User,
  upstreamFilter: readonly string[] | null,
  aliasRepo: ModelAliasesRepo,
): Promise<PublicModelsResponse> => {
  const { callerAddressable, gatewayAddressable, realModels, aliases } = await loadModelListingCatalog(subject, upstreamFilter, aliasRepo);
  const merged = mergeAliasesIntoModels({
    realModels,
    gatewayAddressableModelIds: gatewayAddressable,
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
