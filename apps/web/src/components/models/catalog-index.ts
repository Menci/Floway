import type { ControlPlaneModel } from '../../api/types';

// Built once and passed down: every catalog lookup happens inside a loop over
// another collection, so a per-call scan would be quadratic.
export type CatalogIndex = ReadonlyMap<string, ControlPlaneModel>;

export const indexCatalog = (
  models: readonly ControlPlaneModel[] | null | undefined,
): CatalogIndex => new Map(
  (models ?? [])
    .filter(model => model.aliasedFrom === undefined)
    .map(model => [model.id, model]),
);
