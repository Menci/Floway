import type { ControlPlaneModel } from '../../api/types';

// Every catalog lookup in the dashboard asks the same question — the real
// model addressed by an id — and asks it from inside a loop over another
// collection: per alias target, per row, per candidate while filtering the
// whole catalog. Built once and passed down, so the scan does not repeat.
export type CatalogIndex = ReadonlyMap<string, ControlPlaneModel>;

export const indexCatalog = (
  models: readonly ControlPlaneModel[] | null | undefined,
): CatalogIndex => new Map(
  (models ?? [])
    .filter(model => model.aliasedFrom === undefined)
    .map(model => [model.id, model]),
);
