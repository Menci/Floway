import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { UpstreamUsageChartSection } from '../../../src/components/upstream-usage/chart';
import type { UpstreamUsageChart } from '../../../src/components/upstream-usage/plot';
import { renderInApp } from '../../render';

afterEach(() => vi.restoreAllMocks());
beforeEach(() => vi.spyOn(HTMLSpanElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 40, 12)));

const chart: UpstreamUsageChart = {
  id: 'seat', title: 'Seat',
  entries: [{ id: 'usage', label: 'English meter', unit: 'percent', hue: 210 }],
  values: new Map([['usage', [{ timestamp: 1_000, value: 25 }]]]),
};

it('keeps an active native tooltip valid while series labels are updated', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const view = renderInApp(<UpstreamUsageChartSection chart={chart} start={0} end={60_000} />);
  const application = await screen.findByRole('application', { name: 'Seat' });
  fireEvent.focus(application);
  fireEvent.keyDown(application, { key: 'ArrowRight' });
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('25%'));
  expect(screen.getByRole('status').textContent).toContain('English meter');
  view.rerender(<UpstreamUsageChartSection chart={{ ...chart, entries: [{ ...chart.entries[0]!, label: 'Chinese meter' }] }} start={0} end={60_000} />);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Chinese meter'));
  expect(screen.getByRole('status').textContent).toContain('25%');
});

it('shows the two highest-priority unit axes while retaining every curve and tooltip value', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const multi: UpstreamUsageChart = {
    ...chart,
    entries: [...chart.entries, { id: 'cost', label: 'Cost', unit: 'usd', hue: 30 }, { id: 'credits', label: 'Balance', unit: 'credits', hue: 150 }],
    values: new Map([...chart.values, ['cost', [{ timestamp: 1_000, value: 3 }]], ['credits', [{ timestamp: 1_000, value: 200 }]]]),
  };
  const view = renderInApp(<UpstreamUsageChartSection chart={multi} start={0} end={60_000} />);
  const application = await screen.findByRole('application', { name: 'Seat' });
  await waitFor(() => expect(view.container.querySelectorAll('.recharts-label')[0]!.textContent).toBe('Usage (%)'));
  const axes = view.container.querySelectorAll('.recharts-yAxis');
  expect(axes).toHaveLength(2);
  const labels = view.container.querySelectorAll('.recharts-label');
  expect(labels[1]!.textContent).toBe('Cost (USD)');
  expect(labels[0]!.getAttribute('transform')).toContain('rotate(-90');
  expect(labels[1]!.getAttribute('transform')).toContain('rotate(90');
  const gridLines = view.container.querySelectorAll('.recharts-cartesian-grid-horizontal line');
  expect(gridLines.length).toBeGreaterThanOrEqual(4);
  for (const line of gridLines) expect(line.getAttribute('y1')).toBe(line.getAttribute('y2'));
  const tickYs = [...view.container.querySelectorAll('.recharts-yAxis-tick-labels')[0]!.querySelectorAll('text')].map(tick => tick.getAttribute('y'));
  for (const y of tickYs) expect([...gridLines].some(line => line.getAttribute('y1') === y)).toBe(true);
  expect(view.container.querySelectorAll('.recharts-line-curve')).toHaveLength(3);
  expect(view.container.querySelectorAll('.recharts-wrapper')).toHaveLength(1);
  expect(view.container.textContent).toContain('100%');
  expect(view.container.textContent).toContain('$3.00');
  expect(view.container.textContent).not.toContain('200');
  fireEvent.focus(application);
  fireEvent.keyDown(application, { key: 'ArrowRight' });
  fireEvent.keyDown(application, { key: 'ArrowRight' });
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('200'));
  expect(screen.getByRole('status').textContent).toContain('$3.00');
  expect(screen.getByRole('status').textContent).toContain('25%');
});

it('places the highest-priority available unit on the left when percent is absent', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const multi: UpstreamUsageChart = {
    ...chart,
    entries: [{ id: 'credits', label: 'Balance', unit: 'credits', hue: 150 }, { id: 'cost', label: 'Cost', unit: 'usd', hue: 30 }],
    values: new Map([['credits', [{ timestamp: 1_000, value: 200 }]], ['cost', [{ timestamp: 1_000, value: 3 }]]]),
  };
  const view = renderInApp(<UpstreamUsageChartSection chart={multi} start={0} end={60_000} />);
  await screen.findByRole('application', { name: 'Seat' });
  await waitFor(() => expect(view.container.querySelectorAll('.recharts-label')[0]!.textContent).toBe('Cost (USD)'));
  const axes = view.container.querySelectorAll('.recharts-yAxis');
  expect(axes).toHaveLength(2);
  expect(view.container.querySelectorAll('.recharts-label')[1]!.textContent).toBe('Credits');
});
