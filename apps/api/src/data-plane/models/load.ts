import { getInternalModels } from '../providers/registry.ts';
import type { InternalModel } from '../providers/types.ts';
import type { PublicModel, PublicModelsResponse } from '@floway-dev/protocols/common';

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
  return info;
};

export const loadModels = async (upstreamFilter?: readonly string[] | null): Promise<PublicModelsResponse> => {
  const data = (await getInternalModels(upstreamFilter)).map(toPublicModel);
  return {
    object: 'list',
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    data,
  };
};
