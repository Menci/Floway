import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { expect, it, vi } from 'vitest';

import { resetCycles, resetLoadedAt } from './reset-fixture';
import { isResetRange, type DashboardRange } from '../../../src/components/charts/dashboard-time';
import { TelemetryRangeControls } from '../../../src/components/telemetry/range-controls';
import type { UpstreamResetCycles } from '../../../src/components/telemetry/reset-cycles';
import { renderInApp } from '../../render';

const renderControls = (cycles: UpstreamResetCycles | null = resetCycles) => {
  const change = vi.fn<(range: DashboardRange) => void>();
  const router = createMemoryRouter([{
    path: '/', Component: () => {
      const [range, setRange] = useState<DashboardRange>('today');
      return <TelemetryRangeControls addressOf={null} ariaLabel="Usage range" loadedAt={resetLoadedAt} onChange={next => { change(next); setRange(next); }}
        onEditingChange={() => {}} range={range} resetCycles={cycles} />;
    },
  }]);
  renderInApp(<RouterProvider router={router} />);
  return change;
};

it('keeps reset choices out of the shared time control without eligible upstream telemetry', () => {
  renderControls(null);
  expect(screen.queryByRole('combobox', { name: 'Reset metric' })).toBeNull();
  expect(screen.queryByRole('radio', { name: 'Current reset cycle' })).toBeNull();
  expect(screen.getByRole('radio', { name: '7 Days' })).toBeTruthy();
});

it('uses the selected quota metric for both current and previous cycles', () => {
  const change = renderControls();
  expect(screen.queryByRole('combobox', { name: 'Reset metric' })).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: 'Previous reset cycle' }));
  expect(change.mock.lastCall?.[0]).toMatchObject({ cycle: 'previous', start: resetCycles.metrics[0]!.previousStart, end: resetCycles.metrics[0]!.currentStart });
  fireEvent.click(screen.getByRole('combobox', { name: 'Reset metric' }));
  fireEvent.click(screen.getByRole('option', { name: '7-day remaining' }));
  expect(change.mock.lastCall?.[0]).toMatchObject({ cycle: 'previous', metric: resetCycles.metrics[1]!.identity, start: resetCycles.metrics[1]!.previousStart, end: resetCycles.metrics[1]!.currentStart });
  fireEvent.click(screen.getByRole('radio', { name: 'Current reset cycle' }));
  const current = change.mock.lastCall?.[0];
  expect(current && isResetRange(current) && current.start).toBe(resetCycles.metrics[1]!.currentStart);
  fireEvent.click(screen.getByRole('radio', { name: '7 Days' }));
  expect(change.mock.lastCall?.[0]).toBe('7d');
  expect(screen.queryByRole('combobox', { name: 'Reset metric' })).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: 'Current reset cycle' }));
  expect(screen.getByRole('combobox', { name: 'Reset metric' }).textContent).toContain('7-day remaining');
});

it('enters an available cycle even when the first observed metric has insufficient history', () => {
  const change = renderControls({ ...resetCycles, metrics: [{ ...resetCycles.metrics[0]!, currentStart: null, previousStart: null }, resetCycles.metrics[1]!] });
  fireEvent.click(screen.getByRole('radio', { name: 'Previous reset cycle' }));
  expect(change.mock.lastCall?.[0]).toMatchObject({ cycle: 'previous', metric: resetCycles.metrics[1]!.identity });
});

it('lists unnamed observed metrics by their raw identities when display names collide', () => {
  const metrics = resetCycles.metrics.map((metric, index) => ({ ...metric, identity: { name: 'quota.utilization', labels: { quota: `unnamed_${index}` } }, display: { name: 'Unnamed', labelKey: null, windowSeconds: null } }));
  const change = renderControls({ ...resetCycles, metrics });
  fireEvent.click(screen.getByRole('radio', { name: 'Current reset cycle' }));
  fireEvent.click(screen.getByRole('combobox', { name: 'Reset metric' }));
  fireEvent.click(screen.getByRole('option', { name: 'quota.utilization{quota="unnamed_1"}' }));
  expect(change.mock.lastCall?.[0]).toMatchObject({ metric: metrics[1]!.identity });
});

it('shows unavailable cycles as disabled until their boundaries have been observed', () => {
  const change = renderControls({ ...resetCycles, metrics: [{ ...resetCycles.metrics[0]!, currentStart: null, previousStart: null }] });
  const current = screen.getByRole('radio', { name: 'Current reset cycle' });
  expect(current.getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByRole('radio', { name: 'Previous reset cycle' }).getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(current);
  expect(change).not.toHaveBeenCalled();
});
