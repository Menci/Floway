import { scopeDepth, scopeKind, scopeResourceId, type ScopeKind } from './scope';
import type { AccessRecord } from '../../api/types';
import type { AccessScope } from '@floway-dev/gateway/browser';

const FAMILY_ORDER: Record<ScopeKind, number> = { upstream: 0, self: 1, user: 2, group: 3 };
const family = (scope: AccessScope) => FAMILY_ORDER[scopeKind(scope)!];

// Model patterns share the resolver's depth and order group: exact matches do
// not outrank regex matches. Other scopes never enter a draggable segment.
export const orderedRecords = (records: readonly AccessRecord[]): AccessRecord[] => records.toSorted((left, right) =>
  scopeDepth(left.scope) - scopeDepth(right.scope)
  || family(left.scope) - family(right.scope)
  || scopeResourceId(left.scope).localeCompare(scopeResourceId(right.scope), 'en', { numeric: true })
  || left.sortOrder - right.sortOrder || left.id - right.id);

export interface RecordSegment { key: string; movable: boolean; records: AccessRecord[] }

export const recordSegments = (records: readonly AccessRecord[]): RecordSegment[] => {
  const segments: RecordSegment[] = [];
  for (const record of orderedRecords(records)) {
    const movable = record.scope.kind === 'upstreamModel';
    // Model-pattern priority is a single ordered list per upstream: the
    // resolver compares the stored sort order across every principal, so the
    // editor must expose the same list as one draggable segment.
    const resource = scopeResourceId(record.scope);
    const key = movable ? `upstream:${resource}` : `fixed:${record.scope.kind}:${resource}`;
    const previous = segments.at(-1);
    if (previous?.key === key) previous.records.push(record);
    else segments.push({ key, movable, records: [record] });
  }
  return segments;
};

export const reorderModelRecords = (records: readonly AccessRecord[], visibleIds: readonly number[], from: number, to: number): AccessRecord[] => {
  if (visibleIds.length < 2 || new Set(visibleIds).size !== visibleIds.length
    || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= visibleIds.length || to >= visibleIds.length) {
    throw new Error('Invalid access-rule reorder positions');
  }
  const segment = recordSegments(records).find(segment => segment.movable && visibleIds.every(id => segment.records.some(record => record.id === id)));
  if (!segment) throw new Error('Access-rule reorder crosses a fixed priority boundary');
  const visibleSet = new Set(visibleIds);
  const visible = segment.records.filter(record => visibleSet.has(record.id));
  if (visible.some((record, index) => record.id !== visibleIds[index])) throw new Error('Access-rule reorder uses a stale visible order');
  const [moved] = visible.splice(from, 1);
  visible.splice(to, 0, moved);
  let cursor = 0;
  const reordered = segment.records.map(record => visibleSet.has(record.id) ? visible[cursor++] : record);
  const ranks = new Map(reordered.map((record, index) => [record.id, index]));
  return records.map(record => ranks.has(record.id) ? { ...record, sortOrder: ranks.get(record.id)! } : record);
};
