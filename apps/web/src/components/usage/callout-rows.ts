import type { CalloutRow } from './types';

export const orderedCalloutRows = (rows: readonly CalloutRow[]): CalloutRow[] =>
  rows.toSorted((left, right) => right.value - left.value);
