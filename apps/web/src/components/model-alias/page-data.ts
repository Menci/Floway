import type { InferResponseType } from 'hono/client';

import type { api, ApiResult } from '../../api/client';
import type { ControlPlaneModel } from '../../api/types';
import type { ModelAlias } from '@floway-dev/protocols/common';

type ModelsResponse = InferResponseType<typeof api.api.models.$get, 200>;

export interface ModelAliasesPageData {
  aliases: ModelAlias[];
  models: ControlPlaneModel[] | null;
  aliasError: string | null;
  modelsError: string | null;
}

export const mergeModelAliasesPageData = (
  current: Pick<ModelAliasesPageData, 'aliases' | 'models'>,
  aliasResult: ApiResult<ModelAlias[]>,
  modelsResult: ApiResult<ModelsResponse>,
): ModelAliasesPageData => {
  return {
    aliases: aliasResult.data ?? current.aliases,
    models: modelsResult.data?.data ?? current.models,
    aliasError: aliasResult.error?.message ?? null,
    modelsError: modelsResult.error?.message ?? null,
  };
};
