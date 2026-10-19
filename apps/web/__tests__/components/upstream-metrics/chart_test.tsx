import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { LinkedChartHoverProvider, useLinkedChartHover } from '../../../src/components/charts/linked-hover';
import { UpstreamMetricsChartSection } from '../../../src/components/upstream-metrics/chart';
import { buildUpstreamMetricsChart, type UpstreamMetricsChart } from '../../../src/components/upstream-metrics/plot';
import { renderInApp } from '../../render';
import { upstreamMetricAxisPriority, type UpstreamMetricSample } from '@floway-dev/provider/browser';
import { resolveUpstreamMetricDisplays } from '@floway-dev/provider-codex/browser';

afterEach(() => vi.restoreAllMocks());
beforeEach(() => vi.spyOn(HTMLSpanElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 40, 12)));

const chart: UpstreamMetricsChart = {
  id: 'seat', title: 'Seat', hiddenByDefault: new Set(),
  entries: [{ id: 'usage', label: 'English meter', unit: 'percent', axisPriority: upstreamMetricAxisPriority.subscriptionQuota, form: 'line', hue: 210 }],
  values: new Map([['usage', [{ timestamp: 1_000, value: 25 }, { timestamp: 60_000, value: 25 }]]]),
};
const costEntry: UpstreamMetricsChart['entries'][number] = { id: 'cost', label: 'Cost', unit: 'usd', axisPriority: upstreamMetricAxisPriority.activityCost, form: 'line', hue: 30 };
const chartWithCost = (hiddenByDefault: readonly string[] = []): UpstreamMetricsChart => ({
  ...chart,
  hiddenByDefault: new Set(hiddenByDefault),
  entries: [...chart.entries, costEntry],
  values: new Map([
    ['usage', chart.values.get('usage')!],
    ['cost', [{ timestamp: 1_000, value: 3 }, { timestamp: 60_000, value: 3 }]],
  ]),
});
const legendButton = (label: string) => screen.getAllByText(label).map(node => node.closest('button')).find(button => button !== null)!;
const legendIsHidden = (label: string) => legendButton(label).classList.contains('line-through');

function HoverSource({ xRatio }: { xRatio: number }) {
  const { report } = useLinkedChartHover();
  useEffect(() => {
    report({ xRatio, yRatio: 0.5 });
    return () => report(null);
  }, [report, xRatio]);
  return null;
}

it('keeps an active native tooltip valid while series labels are updated', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const view = renderInApp(<UpstreamMetricsChartSection chart={chart} start={0} end={60_000} />);
  const application = await screen.findByRole('application', { name: 'Seat' });
  fireEvent.focus(application);
  fireEvent.keyDown(application, { key: 'ArrowRight' });
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('25%'));
  expect(screen.getByRole('status').textContent).toContain('English meter');
  view.rerender(<UpstreamMetricsChartSection chart={{ ...chart, entries: [{ ...chart.entries[0]!, label: 'Chinese meter' }] }} start={0} end={60_000} />);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Chinese meter'));
  expect(screen.getByRole('status').textContent).toContain('25%');
});

it('shows the point nearest the position another chart reports', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const linkedChart = { ...chart, values: new Map([['usage', [{ timestamp: 1_000, value: 25 }, { timestamp: 60_000, value: 75 }]]]) };
  const view = renderInApp(<LinkedChartHoverProvider>
    <HoverSource xRatio={0.6} />
    <UpstreamMetricsChartSection chart={linkedChart} start={0} end={90_000} />
  </LinkedChartHoverProvider>);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('75%'));
  // 1_000 and 60_000 straddle 0.339 of the range, so a position just left of it
  // still belongs to the earlier point.
  view.rerender(<LinkedChartHoverProvider>
    <HoverSource xRatio={0.33} />
    <UpstreamMetricsChartSection chart={linkedChart} start={0} end={90_000} />
  </LinkedChartHoverProvider>);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('25%'));
});

it('hides an unchanged marker without removing its tooltip point', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const repeated = { ...chart, values: new Map([['usage', [{ timestamp: 1_000, value: 25 }, { timestamp: 20_000, value: 25 }, { timestamp: 40_000, value: 25 }, { timestamp: 60_000, value: 75 }]]]) };
  const view = renderInApp(<UpstreamMetricsChartSection chart={repeated} start={0} end={60_000} />);
  const application = await screen.findByRole('application', { name: 'Seat' });
  await waitFor(() => expect(view.container.querySelectorAll('.recharts-line-dots circle')).toHaveLength(4));
  expect([...view.container.querySelectorAll('.recharts-line-dots circle')].map(circle => circle.getAttribute('r'))).toEqual(['2', '0', '2', '2']);
  fireEvent.focus(application);
  fireEvent.keyDown(application, { key: 'ArrowRight' });
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('25%'));
});

it('shows only the highest-priority metric axis while retaining every curve and tooltip value', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const multi: UpstreamMetricsChart = {
    ...chart,
    entries: [...chart.entries, { id: 'cost', label: 'Cost', unit: 'usd', axisPriority: upstreamMetricAxisPriority.activityCost, form: 'line', hue: 30 }, { id: 'credits', label: 'Balance', unit: 'credits', axisPriority: upstreamMetricAxisPriority.purchasedBalance, form: 'line', hue: 150 }],
    values: new Map([...chart.values, ['cost', [{ timestamp: 1_000, value: 3 }, { timestamp: 60_000, value: 3 }]], ['credits', [{ timestamp: 1_000, value: 200 }, { timestamp: 60_000, value: 200 }]]]),
  };
  const view = renderInApp(<UpstreamMetricsChartSection chart={multi} start={0} end={60_000} />);
  const application = await screen.findByRole('application', { name: 'Seat' });
  await waitFor(() => expect(view.container.querySelectorAll('.recharts-yAxis-tick-labels')[0]!.textContent).toContain('100%'));
  const axes = view.container.querySelectorAll('.recharts-yAxis');
  expect(axes).toHaveLength(1);
  const ticks = view.container.querySelectorAll('.recharts-yAxis-tick-labels');
  expect(ticks[0]!.querySelector('text')!.getAttribute('text-anchor')).toBe('end');
  expect(view.container.querySelectorAll('.recharts-label')).toHaveLength(0);
  const gridLines = view.container.querySelectorAll('.recharts-cartesian-grid-horizontal line');
  expect(gridLines.length).toBeGreaterThanOrEqual(4);
  for (const line of gridLines) expect(line.getAttribute('y1')).toBe(line.getAttribute('y2'));
  const tickYs = [...view.container.querySelectorAll('.recharts-yAxis-tick-labels')[0]!.querySelectorAll('text')].map(tick => tick.getAttribute('y'));
  for (const y of tickYs) expect([...gridLines].some(line => line.getAttribute('y1') === y)).toBe(true);
  expect(view.container.querySelectorAll('.recharts-line-curve')).toHaveLength(3);
  expect(view.container.querySelectorAll('.recharts-wrapper')).toHaveLength(1);
  expect(view.container.textContent).toContain('100%');
  expect(view.container.textContent).not.toContain('$3.00');
  expect(view.container.textContent).not.toContain('200');
  fireEvent.focus(application);
  fireEvent.keyDown(application, { key: 'ArrowRight' });
  fireEvent.keyDown(application, { key: 'ArrowRight' });
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('200'));
  expect(screen.getByRole('status').textContent).not.toContain('credits');
  expect(screen.getByRole('status').textContent).toContain('$3.00');
  expect(screen.getByRole('status').textContent).toContain('25%');
  fireEvent.click(legendButton('English meter'));
  await waitFor(() => expect(view.container.querySelector('.recharts-yAxis-tick-labels')!.textContent).toContain('$3.00'));
  expect(view.container.querySelector('.recharts-yAxis-tick-labels')!.textContent).not.toContain('%');
});

it('places the highest-priority available unit on the left when percent is absent', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const multi: UpstreamMetricsChart = {
    ...chart,
    entries: [{ id: 'credits', label: 'Balance', unit: 'credits', axisPriority: upstreamMetricAxisPriority.purchasedBalance, form: 'line', hue: 150 }, { id: 'cost', label: 'Cost', unit: 'usd', axisPriority: upstreamMetricAxisPriority.activityCost, form: 'line', hue: 30 }],
    values: new Map([['credits', [{ timestamp: 1_000, value: 200 }, { timestamp: 60_000, value: 200 }]], ['cost', [{ timestamp: 1_000, value: 3 }, { timestamp: 60_000, value: 3 }]]]),
  };
  const view = renderInApp(<UpstreamMetricsChartSection chart={multi} start={0} end={60_000} />);
  await screen.findByRole('application', { name: 'Seat' });
  await waitFor(() => expect(view.container.querySelectorAll('.recharts-yAxis-tick-labels')[0]!.textContent).toContain('$3.00'));
  const axes = view.container.querySelectorAll('.recharts-yAxis');
  expect(axes).toHaveLength(1);
  expect(view.container.textContent).not.toContain('200');
  expect(view.container.querySelectorAll('.recharts-label')).toHaveLength(0);
});

it('uses the shared chart frame geometry and keeps the outer time labels inside it', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const view = renderInApp(<UpstreamMetricsChartSection chart={chart} start={0} end={60_000} />);
  await screen.findByRole('application', { name: 'Seat' });
  await waitFor(() => expect(view.container.querySelectorAll('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value').length).toBeGreaterThanOrEqual(2));
  const gridLine = view.container.querySelector('.recharts-cartesian-grid-horizontal line')!;
  expect(gridLine.getAttribute('x1')).toBe('54');
  expect(gridLine.getAttribute('x2')).toBe('700');
  const ticks = view.container.querySelectorAll('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value');
  expect(getComputedStyle(ticks[0]!).textAnchor).toBe('start');
  expect(getComputedStyle(ticks[ticks.length - 1]!).textAnchor).toBe('end');
});

it('lets the reader restore an initially hidden empty metric through its legend', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const view = renderInApp(<UpstreamMetricsChartSection chart={{ ...chart, hiddenByDefault: new Set(['usage']) }} start={0} end={60_000} />);
  const legend = screen.getByText('English meter');
  expect(legend.closest('button')!.className).toContain('line-through');
  expect(view.container.querySelector('.recharts-line-curve')).toBeNull();
  fireEvent.click(legend);
  await waitFor(() => expect(view.container.querySelector('.recharts-line-curve')).not.toBeNull());
});

it('reapplies the data-derived default when refreshed data changes it in either direction', async () => {
  const view = renderInApp(<UpstreamMetricsChartSection chart={chart} start={0} end={60_000} />);
  expect(legendIsHidden('English meter')).toBe(false);

  view.rerender(<UpstreamMetricsChartSection chart={{ ...chart, hiddenByDefault: new Set(['usage']) }} start={0} end={60_000} />);
  await waitFor(() => expect(legendIsHidden('English meter')).toBe(true));

  view.rerender(<UpstreamMetricsChartSection chart={chart} start={0} end={60_000} />);
  await waitFor(() => expect(legendIsHidden('English meter')).toBe(false));
});

it('preserves a manual choice while untouched series follow refreshed defaults', async () => {
  const view = renderInApp(<UpstreamMetricsChartSection chart={chartWithCost(['usage'])} start={0} end={60_000} />);
  expect(legendIsHidden('English meter')).toBe(true);
  expect(legendIsHidden('Cost')).toBe(false);

  fireEvent.click(legendButton('English meter'));
  expect(legendIsHidden('English meter')).toBe(false);

  view.rerender(<UpstreamMetricsChartSection chart={chartWithCost(['usage', 'cost'])} start={0} end={60_000} />);
  await waitFor(() => {
    expect(legendIsHidden('English meter')).toBe(false);
    expect(legendIsHidden('Cost')).toBe(true);
  });

  view.rerender(<UpstreamMetricsChartSection chart={chartWithCost()} start={0} end={60_000} />);
  await waitFor(() => {
    expect(legendIsHidden('English meter')).toBe(false);
    expect(legendIsHidden('Cost')).toBe(false);
  });
});

it('only creates bulk overrides for series whose effective visibility changes', async () => {
  const view = renderInApp(<UpstreamMetricsChartSection chart={chartWithCost(['usage'])} start={0} end={60_000} />);
  fireEvent.click(screen.getByRole('button', { name: 'Hide all series' }));
  expect(legendIsHidden('English meter')).toBe(true);
  expect(legendIsHidden('Cost')).toBe(true);

  view.rerender(<UpstreamMetricsChartSection chart={chartWithCost()} start={0} end={60_000} />);
  await waitFor(() => {
    expect(legendIsHidden('English meter')).toBe(false);
    expect(legendIsHidden('Cost')).toBe(true);
  });
});

it('retains an override through missing series and an empty range', async () => {
  const view = renderInApp(<UpstreamMetricsChartSection chart={chartWithCost()} start={0} end={60_000} />);
  fireEvent.click(legendButton('Cost'));
  expect(legendIsHidden('Cost')).toBe(true);

  const withoutCost: UpstreamMetricsChart = {
    ...chart,
    values: new Map([['usage', chart.values.get('usage')!]]),
  };
  view.rerender(<UpstreamMetricsChartSection chart={withoutCost} start={0} end={60_000} />);
  expect(screen.queryByText('Cost')).toBeNull();

  const empty: UpstreamMetricsChart = { ...chart, entries: [], values: new Map(), hiddenByDefault: new Set() };
  view.rerender(<UpstreamMetricsChartSection chart={empty} start={0} end={60_000} />);
  expect(screen.queryByRole('heading', { name: 'Seat' })).toBeNull();

  view.rerender(<UpstreamMetricsChartSection chart={chartWithCost()} start={0} end={60_000} />);
  await waitFor(() => expect(legendIsHidden('Cost')).toBe(true));
});

it('resets visibility overrides when the upstream chart key changes', () => {
  const first = { ...chartWithCost(), id: 'seat-one' };
  const view = renderInApp(<UpstreamMetricsChartSection key={first.id} chart={first} start={0} end={60_000} />);
  fireEvent.click(legendButton('English meter'));
  expect(legendIsHidden('English meter')).toBe(true);

  const second = { ...chartWithCost(), id: 'seat-two' };
  view.rerender(<UpstreamMetricsChartSection key={second.id} chart={second} start={0} end={60_000} />);
  expect(legendIsHidden('English meter')).toBe(false);
});

it('overlays areas independently, connects interior missing points, and leaves outer ranges blank', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const multi: UpstreamMetricsChart = {
    ...chart,
    entries: [{ id: 'area', label: 'Usage', unit: 'percent', axisPriority: upstreamMetricAxisPriority.subscriptionQuota, form: 'area', hue: 210 }, { id: 'line', label: 'Balance', unit: 'percent', axisPriority: upstreamMetricAxisPriority.subscriptionQuota, form: 'line', hue: 30 }],
    values: new Map([
      ['area', [{ timestamp: 10_000, value: 20 }, { timestamp: 50_000, value: 40 }]],
      ['line', [{ timestamp: 30_000, value: 80 }, { timestamp: 50_000, value: 80 }]],
    ]),
  };
  const view = renderInApp(<UpstreamMetricsChartSection chart={multi} start={0} end={60_000} />);
  await waitFor(() => expect(view.container.querySelector('.recharts-area-curve')).not.toBeNull());
  expect(view.container.querySelectorAll('.recharts-area-area')).toHaveLength(1);
  expect(view.container.querySelectorAll('.recharts-line-curve')).toHaveLength(1);
  const points = [...view.container.querySelectorAll('.recharts-area-dots circle')];
  expect(points).toHaveLength(2);
  expect(Number(points[0]!.getAttribute('cx'))).toBeGreaterThan(54);
  expect(Number(points[1]!.getAttribute('cx'))).toBeLessThan(720);
  expect(view.container.querySelector('.recharts-area-curve')!.getAttribute('d')!.match(/M/g)).toHaveLength(1);
});

it.each([Number.MIN_VALUE, -Number.MIN_VALUE, 1e308, -1e308])('renders finite axis progression for %s', async value => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const view = renderInApp(<UpstreamMetricsChartSection chart={{ ...chart, entries: [{ ...chart.entries[0]!, unit: 'usd' }], values: new Map([['usage', [{ timestamp: 1_000, value }, { timestamp: 60_000, value }]]]) }} start={0} end={60_000} />);
  await screen.findByRole('application', { name: 'Seat' });
  expect(view.container.innerHTML).not.toContain('Infinity');
});

it('renders provider-converted observations consistently in curves, axes, and tooltips', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const source: UpstreamMetricSample[] = [
    { name: 'quota.window.used_percent', labels: { limit: 'codex', window_seconds: 18_000 }, timestamp: 1_000, value: 25 },
    { name: 'quota.window.used_percent', labels: { limit: 'codex', window_seconds: 18_000 }, timestamp: 60_000, value: 25 },
    { name: 'credits.balance', labels: {}, timestamp: 1_000, value: 200 },
    { name: 'credits.balance', labels: {}, timestamp: 60_000, value: 200 },
  ];
  const series = resolveUpstreamMetricDisplays(source, { quotaDisplay: 'remaining' });
  const converted = buildUpstreamMetricsChart(series, { id: 'seat', kind: 'codex', name: 'Seat', hue: 210 });
  const view = renderInApp(<UpstreamMetricsChartSection chart={converted} start={0} end={60_000} />);
  const application = await screen.findByRole('application', { name: 'Seat' });
  await waitFor(() => expect(view.container.querySelector('.recharts-area-curve')).not.toBeNull());
  const ticks = view.container.querySelector('.recharts-yAxis-tick-labels')!;
  const tick = [...ticks.querySelectorAll('text')].find(node => node.textContent === '75%')!;
  expect(Number(view.container.querySelector('.recharts-area-dots circle')!.getAttribute('cy'))).toBeCloseTo(Number(tick.getAttribute('y')));
  fireEvent.focus(application);
  fireEvent.keyDown(application, { key: 'ArrowRight' });
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('75%'));
  expect(screen.getByRole('status').textContent).toContain('200');
});
