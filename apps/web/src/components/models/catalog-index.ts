import type { ControlPlaneModel } from '../../api/types';

// Built once and passed down: lookups happen inside loops over other collections, so a per-call scan would be quadratic.
export type CatalogIndex = ReadonlyMap<string, ControlPlaneModel>;

export const indexCatalog = (
  models: readonly ControlPlaneModel[] | null | undefined,
): CatalogIndex => new Map(
  (models ?? [])
    .filter(model => model.aliasedFrom === undefined)
    .map(model => [model.id, model]),
);
