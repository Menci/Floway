import { expect, it } from 'vitest';

import { orderedCalloutRows } from '../../../src/components/usage/callout-rows';
import type { CalloutRow } from '../../../src/components/usage/types';

it('orders callout values without mutating the chart-owned rows', () => {
  const rows: CalloutRow[] = [
    { id: 'low', label: 'Low', color: 'blue', value: 1 },
    { id: 'high', label: 'High', color: 'red', value: 3 },
    { id: 'middle', label: 'Middle', color: 'green', value: 2 },
  ];

  expect(orderedCalloutRows(rows).map(row => row.id)).toEqual(['high', 'middle', 'low']);
  expect(rows.map(row => row.id)).toEqual(['low', 'high', 'middle']);
});
