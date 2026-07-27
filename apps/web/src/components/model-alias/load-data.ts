import type { ApiResult } from "../../api/auth";
import type { ControlPlaneModel, ModelAlias } from "../../api/types";

interface ModelsResponse {
  data: ControlPlaneModel[];
}

export interface ModelAliasesPageData {
  aliases: ModelAlias[];
  models: ControlPlaneModel[] | null;
  aliasError: string | null;
  modelsError: string | null;
}

export function mergeModelAliasesPageData(
  current: Pick<ModelAliasesPageData, "aliases" | "models">,
  aliasResult: ApiResult<ModelAlias[]>,
  modelsResult: ApiResult<ModelsResponse>,
): ModelAliasesPageData {
  return {
    aliases: aliasResult.data ?? current.aliases,
    models: modelsResult.data?.data ?? current.models,
    aliasError: aliasResult.error?.message ?? null,
    modelsError: modelsResult.error?.message ?? null,
  };
}
