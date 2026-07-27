export const nextSortOrder = (existing: readonly { sortOrder: number }[]): number =>
  existing.reduce((highest, record) => Math.max(highest, record.sortOrder), -1) + 1;
