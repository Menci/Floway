import { expect, test } from 'vitest';

import type { ListedUpstreamRecord } from '../../src/api/types';
import { planReorder } from '../../src/routes/dashboard-providers-upstreams';
import { upstreamRecord } from '../api/upstream-fixture';

const record = (
  id: string,
  sortOrder: number,
  editLevel: ListedUpstreamRecord['editLevel'] = 'full',
  reorderGroup: string | null = editLevel === 'full' ? 'full-segment' : null,
): ListedUpstreamRecord => ({
  ...upstreamRecord(id, { kind: 'custom', config: { baseUrl: id, authStyle: 'none', endpoints: {}, ingressHeadersRules: [], modelsFetch: { enabled: false }, models: [] }, state: null }),
  sort_order: sortOrder,
  audit: true,
  editLevel,
  reorderGroup,
} as ListedUpstreamRecord);

test('reorders only the full segment and reuses its sparse marks', () => {
  const snapshot = [record('locked-a', 10, 'off'), record('full-a', 20), record('full-b', 40), record('locked-b', 50, 'off')];
  const plan = planReorder(snapshot, 1, 2);
  expect(plan?.next.map(item => [item.id, item.sort_order])).toEqual([
    ['locked-a', 10], ['full-b', 20], ['full-a', 40], ['locked-b', 50],
  ]);
  expect(plan).toMatchObject({ expectedIds: ['full-a', 'full-b'], ids: ['full-b', 'full-a'] });
});

test('rejects a move that would cross a locked row even when both endpoints are full', () => {
  const snapshot = [record('full-a', 10), record('locked', 20, 'off'), record('full-b', 30)];
  expect(planReorder(snapshot, 0, 2)).toBeNull();
});

test('rejects a move across a hidden server-side boundary', () => {
  const snapshot = [record('full-a', 10, 'full', 'segment-a'), record('full-b', 30, 'full', 'segment-b')];
  expect(planReorder(snapshot, 0, 1)).toBeNull();
});
