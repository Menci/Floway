// Snake_case wire ↔ camelCase record conversion for model aliases. The wire
// shape (`ModelAlias`) lives in `@floway-dev/protocols/common`.

import type { ModelAliasRecord } from '../../repo/types.ts';
import type { ModelAlias } from '@floway-dev/protocols/common';

export const recordToWire = (record: ModelAliasRecord): ModelAlias => ({
  name: record.name,
  kind: record.kind,
  selection: record.selection,
  display_name: record.displayName,
  visible_in_models_list: record.visibleInModelsList,
  targets: record.targets,
  announced_metadata: record.announcedMetadata,
  sort_order: record.sortOrder,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
});

// Server-managed fields (`created_at` / `updated_at` are stamped by the repo;
// `sort_order` defaults to `nextSortOrder` when omitted) are stripped here so
// the create/update bodies cannot dictate them. The remaining required-field
// list rides entirely on `ModelAlias` — a new column in the wire DTO only
// requires editing one place.
export type ModelAliasWireInput =
  & Omit<ModelAlias, 'sort_order' | 'created_at' | 'updated_at'>
  & { sort_order?: number };

export const wireToRecord = (
  wire: ModelAliasWireInput,
  meta: { sortOrder: number; createdAt: string; updatedAt: string },
): ModelAliasRecord => ({
  name: wire.name,
  kind: wire.kind,
  selection: wire.selection,
  displayName: wire.display_name,
  visibleInModelsList: wire.visible_in_models_list,
  targets: wire.targets,
  announcedMetadata: wire.announced_metadata,
  sortOrder: meta.sortOrder,
  createdAt: meta.createdAt,
  updatedAt: meta.updatedAt,
});
