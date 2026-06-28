import { getModels } from '../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { PublicModel, PublicModelsResponse } from '@floway-dev/protocols/common';
import type { InternalModel, Fetcher } from '@floway-dev/provider';

// Project an InternalModel onto the public-facing `/v1/models` wire DTO.
// The DTO doesn't carry per-protocol `endpoints` — listing names the model;
// clients exercise its reach by calling the matching endpoint.
export const toPublicModel = (model: InternalModel): PublicModel => {
  const info: PublicModel = {
    id: model.id,
    object: 'model',
    type: 'model',
    display_name: model.display_name ?? model.id,
    limits: { ...model.limits },
    kind: model.kind,
  };
  if (model.owned_by !== undefined) info.owned_by = model.owned_by;
  if (model.created !== undefined) {
    info.created = model.created;
    info.created_at = new Date(model.created * 1000).toISOString();
  }
  if (model.cost) info.cost = model.cost;
  if (model.chat) info.chat = model.chat;
  return info;
};

export const loadModels = async (
  upstreamFilter: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<PublicModelsResponse> => {
  const { models } = await getModels(upstreamFilter, fetcherForUpstream, scheduler);
  const data = models.map(toPublicModel);
  return {
    object: 'list',
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    data,
  };
};
