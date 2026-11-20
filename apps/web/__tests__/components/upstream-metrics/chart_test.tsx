import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { UpstreamMetricsChartSection } from '../../../src/components/upstream-metrics/chart';
import { type UpstreamMetricsChart } from '../../../src/components/upstream-metrics/plot';
import { renderInApp } from '../../render';
import { upstreamMetricAxisPriority } from '@floway-dev/provider/browser';

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

// Both extremes in one mount: a chart's axis domain and point geometry are
// scale-invariant, so the smallest and largest representable magnitudes at each
// sign cover the overflow and underflow branches without a render per value.
it.each([[Number.MIN_VALUE, -Number.MIN_VALUE], [1e308, -1e308]])('renders finite axis progression for %s and %s', async (...values) => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const view = renderInApp(<UpstreamMetricsChartSection chart={{ ...chart, entries: [{ ...chart.entries[0]!, unit: 'usd' }], values: new Map([['usage', values.flatMap(value => [{ timestamp: 1_000, value }, { timestamp: 60_000, value }])]]) }} start={0} end={60_000} />);
  await screen.findByRole('application', { name: 'Seat' });
  expect(view.container.innerHTML).not.toContain('Infinity');
});
