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
