import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { UpstreamUsageChartSection } from '../../../src/components/upstream-usage/chart';
import type { UpstreamUsageChart } from '../../../src/components/upstream-usage/plot';
import { renderInApp } from '../../render';

afterEach(() => vi.restoreAllMocks());

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

it('renders three independent unit axes in one native chart', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 720, 320));
  const multi: UpstreamUsageChart = {
    ...chart,
    entries: [...chart.entries, { id: 'cost', label: 'Cost', unit: 'usd', hue: 30 }, { id: 'credits', label: 'Balance', unit: 'credits', hue: 150 }],
    values: new Map([...chart.values, ['cost', [{ timestamp: 1_000, value: 3 }]], ['credits', [{ timestamp: 1_000, value: 200 }]]]),
  };
  const view = renderInApp(<UpstreamUsageChartSection chart={multi} start={0} end={60_000} />);
  await screen.findByRole('application', { name: 'Seat' });
  expect(view.container.querySelectorAll('.recharts-yAxis')).toHaveLength(3);
  expect(view.container.querySelectorAll('.recharts-wrapper')).toHaveLength(1);
  expect(view.container.textContent).toContain('100%');
  expect(view.container.textContent).toContain('$3.00');
  expect(view.container.textContent).toContain('200');
});
