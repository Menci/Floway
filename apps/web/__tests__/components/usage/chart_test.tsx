import { screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import type { ChartBucket } from '../../../src/components/charts/dashboard-time';
import { LinkedChartHoverProvider, useLinkedChartHover } from '../../../src/components/charts/linked-hover';
import { UsageChart } from '../../../src/components/usage/chart';
import { buildTokenChart } from '../../../src/components/usage/plot';
import type { DisplayUsageRecord } from '../../../src/components/usage/types';
import { renderInApp } from '../../render';

afterEach(() => vi.restoreAllMocks());

function HoverSource({ xRatio }: { xRatio: number }) {
  const { report } = useLinkedChartHover();
  useEffect(() => {
    report({ xRatio, yRatio: 0.5 });
    return () => report(null);
  }, [report, xRatio]);
  return null;
}

it('renders its own callout for the bucket nearest the position another chart reports', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const hour = 3_600_000;
  const buckets: ChartBucket[] = [0, 1].map(index => ({
    key: `bucket-${index}`,
    label: `${index}:00 - ${index + 1}:00`,
    date: new Date(index * hour),
    start: index * hour,
    end: (index + 1) * hour,
  }));
  const records: DisplayUsageRecord[] = buckets.map((bucket, index) => ({
    bucket: bucket.key,
    group: 'key-1',
    requests: 1,
    metrics: { input_tokens: String((index + 1) * 10) },
    cost: null,
  }));
  const chart = buildTokenChart({
    records,
    dimensionOptions: [{ value: 'key-1', label: 'Key 1' }],
    metric: 'total',
    range: 'today',
    buckets,
  });
  const view = renderInApp(<LinkedChartHoverProvider>
    <HoverSource xRatio={0.6} />
    <UsageChart chart={chart} hidden={new Set()} valueFormatter={String} />
  </LinkedChartHoverProvider>);
  await waitFor(() => expect(view.container.querySelector('[data-chart-assumed-hover-cursor]')).not.toBeNull());
  expect(screen.getByRole('status').textContent).toContain('1:00 - 2:00');
  expect(screen.getByRole('status').textContent).toContain('20');
});

it('hides run-interior markers while retaining their focusable data points', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const hour = 3_600_000;
  const buckets: ChartBucket[] = [0, 1, 2, 3].map(index => ({
    key: `bucket-${index}`,
    label: `${index}:00 - ${index + 1}:00`,
    date: new Date(index * hour),
    start: index * hour,
    end: (index + 1) * hour,
  }));
  const chart = buildTokenChart({
    records: buckets.map((bucket, index) => ({
      bucket: bucket.key,
      group: 'key-1',
      requests: 1,
      metrics: { input_tokens: index === 3 ? '20' : '10' },
      cost: null,
    })),
    dimensionOptions: [{ value: 'key-1', label: 'Key 1' }],
    metric: 'total',
    range: 'today',
    buckets,
  });
  const view = renderInApp(<UsageChart chart={chart} hidden={new Set()} valueFormatter={String} />);
  await waitFor(() => expect(view.container.querySelectorAll('circle[data-chart-point-marker]')).toHaveLength(4));
  const circles = [...view.container.querySelectorAll<SVGCircleElement>('circle[data-chart-point-marker]')];
  expect(circles.map(circle => circle.dataset.chartPointMarker)).toEqual(['boundary', 'interior', 'boundary', 'boundary']);
  expect(circles[1]!.getAttribute('aria-label')).toContain('1:00 - 2:00');
  expect(circles[1]!.getAttribute('tabindex')).toBe('0');
});

it('draws no assumed tooltip at a bucket the visible series has no reading for', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const hour = 3_600_000;
  const buckets: ChartBucket[] = [0, 1, 2].map(index => ({
    key: `bucket-${index}`,
    label: `${index}:00 - ${index + 1}:00`,
    date: new Date(index * hour),
    start: index * hour,
    end: (index + 1) * hour,
  }));
  // The group has a reading in buckets 0 and 2 only, so bucket 1 is empty: a
  // position near it resolves to a bucket whose callout body has no rows.
  const chart = buildTokenChart({
    records: [
      { bucket: 'bucket-0', group: 'key-1', requests: 1, metrics: { input_tokens: '10' }, cost: null },
      { bucket: 'bucket-2', group: 'key-1', requests: 1, metrics: { input_tokens: '30' }, cost: null },
    ],
    dimensionOptions: [{ value: 'key-1', label: 'Key 1' }],
    metric: 'total',
    range: 'today',
    buckets,
  });
  const view = renderInApp(<LinkedChartHoverProvider>
    <HoverSource xRatio={0.5} />
    <UsageChart chart={chart} hidden={new Set()} valueFormatter={String} />
  </LinkedChartHoverProvider>);
  // The cursor line alone is correct wherever the hover is; a caller that has
  // nothing to say must not mount the popover around it either.
  await waitFor(() => expect(view.container.querySelector('[data-chart-assumed-hover-cursor]')).not.toBeNull());
  expect(screen.queryByRole('status')).toBeNull();
});

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
