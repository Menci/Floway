import { waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { ChartBucket } from '../../../src/components/charts/dashboard-time';
import { PerformanceChartSection } from '../../../src/components/performance/chart';
import { performanceLabels, type PerformanceDisplayRecord, type PerformanceOverviewResponse } from '../../../src/components/performance/overview';
import { buildPerformanceChart } from '../../../src/components/performance/plot';
import { renderInApp } from '../../render';

afterEach(() => vi.restoreAllMocks());

const hour = 3_600_000;
const buckets: ChartBucket[] = [0, 1].map(index => ({
  key: `bucket-${index}`,
  label: `${index}:00 - ${index + 1}:00`,
  date: new Date(index * hour),
  start: index * hour,
  end: (index + 1) * hour,
}));

const emptyOverview: PerformanceOverviewResponse = {
  series: [],
  axes: { none: [], keyId: [], userId: [], model: [], upstream: [], operation: [], runtimeLocation: [] },
  dimensionValues: { models: [], upstreams: [], operations: [], runtimeLocations: [], keyIds: [], userIds: [] },
  users: [],
  upstreams: [],
  keys: [],
};

const records: PerformanceDisplayRecord[] = buckets.map((bucket, index) => ({
  bucket: bucket.key,
  group: 'model-a',
  requests: 10,
  errors: 0,
  ttftSamples: 9,
  tpotSamples: 9,
  neutral: 0,
  ttftMsP50: 1000 + index,
  ttftMsP95: 1200 + index,
  ttftMsP99: 1300,
  tpotUsP50: 20_000,
  tpotUsP95: 22_000,
  tpotUsP99: 24_000,
}));

const chart = buildPerformanceChart(records, 'ttft', { ttft: 'p95', tokPerSec: 'p95' }, 'model', performanceLabels(emptyOverview, []), buckets, 'today');

it('wears the shared chart frame, so its callout takes the dashboard surface', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const view = renderInApp(<PerformanceChartSection chart={chart} hidden={new Set()} onHiddenChange={() => {}} title="Performance" />);
  await waitFor(() => expect(view.container.querySelector('svg[role="region"]')).not.toBeNull());

  // Fluent mounts the callout under the chart's own root, so the frame rule is
  // what styles it. Probing with a real surface is how the WinUI padding and the
  // acrylic fill are read back, rather than restating the rule under test.
  const root = view.container.querySelector('.fui-cart__root')!;
  const surface = document.createElement('div');
  surface.className = 'fui-PopoverSurface';
  surface.appendChild(document.createElement('table'));
  root.appendChild(surface);

  const style = getComputedStyle(surface);
  expect(style.backdropFilter).toBe('blur(8px)');
  expect(style.padding).toBe('6px 9px 8px');
});
