import { waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { ChartBucket } from '../../../src/components/charts/dashboard-time';
import { UsageChart } from '../../../src/components/usage/chart';
import { buildTokenChart } from '../../../src/components/usage/plot';
import { renderInApp } from '../../render';

afterEach(() => vi.restoreAllMocks());

it('spans the whole plot with its hover target, not just up to the last nice tick', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const hour = 3_600_000;
  // Fluent used to size the transparent hover target from the x of the last
  // *nice tick*, which is not the axis end, so the right edge of the plot
  // stopped answering the pointer. A window starting off a tick boundary is
  // what separates the two.
  const base = Date.UTC(2026, 0, 1, 9, 0, 0, 0);
  const buckets: ChartBucket[] = Array.from({ length: 41 }, (_, index) => ({
    key: `bucket-${index}`,
    label: `${index}h`,
    date: new Date(base + index * hour),
    start: base + index * hour,
    end: base + (index + 1) * hour,
  }));
  const chart = buildTokenChart({
    records: buckets.map(bucket => ({ bucket: bucket.key, group: 'key-1', requests: 1, metrics: { input_tokens: '100' }, cost: null })),
    dimensionOptions: [{ value: 'key-1', label: 'Key 1' }],
    metric: 'total',
    range: 'today',
    buckets,
  });
  const view = renderInApp(<UsageChart chart={chart} hidden={new Set()} valueFormatter={String} />);
  await waitFor(() => expect(view.container.querySelector('rect[id^="rectangle"]')).not.toBeNull());
  const width = Number(view.container.querySelector('rect[id^="rectangle"]')!.getAttribute('width'));
  const lastMarker = Math.max(...[...view.container.querySelectorAll('circle[data-chart-point-marker]')].map(circle => Number(circle.getAttribute('cx'))));
  expect(width).toBeCloseTo(720 - 20);
  expect(width).toBeCloseTo(lastMarker);
});
