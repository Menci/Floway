import { describe, expect, it } from 'vitest';

import { orderedRecords, recordSegments, reorderModelRecords } from '../../../src/components/access-control/order';
import type { AccessRecord, AccessScope } from '@floway-dev/gateway/browser';

const record = (id: number, scope: AccessScope, sortOrder = 0): AccessRecord => ({
  id, scope, sortOrder, principal: { kind: 'user', id: 2 }, values: { 'Model.Use': true }, createdAt: '', updatedAt: '',
});
const model = (id: number, upstreamId: string, kind: 'exact' | 'regex', sortOrder = 0) => record(id, { kind: 'upstreamModel', upstreamId, model: { kind, value: 'gpt' } }, sortOrder);
const records = [
  record(1, { kind: 'upstreams' }), record(2, { kind: 'upstream', upstreamId: 'a' }),
  model(3, 'a', 'regex'), model(4, 'a', 'exact', 1), model(5, 'a', 'regex', 2),
  model(6, 'b', 'exact'), model(7, 'b', 'regex', 1), record(8, { kind: 'users' }),
];

describe('access-rule display order', () => {
  it('puts shallow scopes first, then sorts by resource type and path', () => {
    expect(orderedRecords(records).map(record => record.id)).toEqual([1, 8, 2, 3, 4, 5, 6, 7]);
    expect(recordSegments(records).map(segment => ({ key: segment.key, movable: segment.movable, ids: segment.records.map(record => record.id) }))).toEqual([
      { key: 'fixed:upstreams:', movable: false, ids: [1] },
      { key: 'fixed:users:', movable: false, ids: [8] },
      { key: 'fixed:upstream:a', movable: false, ids: [2] },
      { key: 'upstream:a', movable: true, ids: [3, 4, 5] },
      { key: 'upstream:b', movable: true, ids: [6, 7] },
    ]);
  });

  it('allows exact and regex patterns to exchange priority', () => {
    const next = reorderModelRecords(records, [3, 4, 5], 0, 2);
    expect(orderedRecords(next).map(record => record.id)).toEqual([1, 8, 2, 4, 5, 3, 6, 7]);
    expect(next.filter(record => [1, 2, 6, 7, 8].includes(record.id))).toEqual(records.filter(record => [1, 2, 6, 7, 8].includes(record.id)));
    expect(records.find(record => record.id === 3)!.sortOrder).toBe(0);
  });

  it('retains hidden rule positions when reordering filtered or paginated rows', () => {
    const next = reorderModelRecords(records, [3, 5], 0, 1);
    expect(orderedRecords(next).map(record => record.id)).toEqual([1, 8, 2, 5, 4, 3, 6, 7]);
  });

  it('does not let a principal or a manual rank move a rule across scope paths', () => {
    const shuffled = [
      { ...model(10, 'b', 'regex'), principal: { kind: 'user' as const, id: 1 } },
      { ...model(11, 'a', 'exact', 99), principal: { kind: 'group' as const, id: 9 } },
      record(12, { kind: 'user', userId: 10 }),
      record(13, { kind: 'user', userId: 2 }),
    ];
    expect(orderedRecords(shuffled).map(record => record.id)).toEqual([13, 12, 11, 10]);
  });

  it.each([[3, 6], [2, 3], [1, 8]])('rejects cross-boundary rows %j', (...ids) => {
    expect(() => reorderModelRecords(records, ids, 0, 1)).toThrow('fixed priority boundary');
  });

  it('rejects invalid, duplicate and stale indices', () => {
    for (const [ids, from, to] of [[[3, 4], -1, 1], [[3, 4], 0, 2], [[3, 3], 0, 1], [[3], 0, 0], [[3, 4], 0.5, 1]] as const) {
      expect(() => reorderModelRecords(records, ids, from, to)).toThrow('Invalid access-rule reorder positions');
    }
    expect(() => reorderModelRecords(records, [4, 3], 0, 1)).toThrow('stale visible order');
  });
});
