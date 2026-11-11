import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { expect, it, vi } from 'vitest';

import { resetCycles, resetLoadedAt } from './reset-fixture';
import type { DashboardRange } from '../../../src/components/charts/dashboard-time';
import { TelemetryRangeControls } from '../../../src/components/telemetry/range-controls';
import type { UpstreamResetCycles } from '../../../src/components/telemetry/reset-cycles';
import { renderInApp } from '../../render';

const renderControls = (cycles: UpstreamResetCycles | null = resetCycles) => {
  const change = vi.fn<(range: DashboardRange) => void>();
  const editing = vi.fn();
  const router = createMemoryRouter([{
    path: '/', Component: () => {
      const [range, setRange] = useState<DashboardRange>('today');
      return <>
        <TelemetryRangeControls addressOf={null} ariaLabel="Usage range" loadedAt={resetLoadedAt} onChange={next => { change(next); setRange(next); }}
          onEditingChange={editing} range={range} resetCycles={cycles} />
        <button type="button">Outside</button>
      </>;
    },
  }]);
  renderInApp(<RouterProvider router={router} />);
  return { change, editing };
};

const open = () => fireEvent.click(screen.getByRole('radio', { name: 'By cycle' }));
const chooseCycle = (name: string) => {
  fireEvent.click(screen.getByRole('combobox', { name: 'Cycle' }));
  const option = screen.getByRole('option', { name });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
};
const chooseMetric = (name: string) => {
  fireEvent.click(screen.getByRole('combobox', { name: 'Reset metric' }));
  const option = screen.getByRole('option', { name });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
};
const apply = () => fireEvent.click(screen.getByRole('button', { name: 'View statistics' }));

it('keeps reset choices out of the shared time control without eligible upstream telemetry', () => {
  renderControls(null);
  expect(screen.queryByRole('combobox', { name: 'Reset metric' })).toBeNull();
  expect(screen.queryByRole('radio', { name: 'Current reset cycle' })).toBeNull();
  expect(screen.queryByRole('radio', { name: 'By cycle' })).toBeNull();
  expect(screen.getByRole('radio', { name: '7 Days' })).toBeTruthy();
});

it('combines reset cycles into one entry and applies metric and cycle choices together', () => {
  const { change } = renderControls();
  expect(screen.queryByRole('combobox', { name: 'Reset metric' })).toBeNull();
  expect(screen.queryByRole('radio', { name: 'Previous reset cycle' })).toBeNull();
  open();
  expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Reset metric' }));
  chooseCycle('Previous reset cycle');
  chooseMetric('7-day remaining');
  expect(screen.getByRole('dialog', { name: 'Choose reset cycle' })).toBeTruthy();
  expect(change).not.toHaveBeenCalled();
  apply();
  expect(change.mock.lastCall?.[0]).toMatchObject({ cycle: 'previous', metric: resetCycles.metrics[1]!.identity, start: resetCycles.metrics[1]!.previousStart, end: resetCycles.metrics[1]!.currentStart });
  expect(screen.queryByRole('combobox', { name: 'Reset metric' })).toBeNull();
  expect(screen.getByRole('radio', { name: 'By cycle' }).getAttribute('aria-checked')).toBe('true');
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'By cycle' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose reset cycle' }));
  chooseCycle('Current reset cycle');
  apply();
  expect(change.mock.lastCall?.[0]).toMatchObject({ cycle: 'current', start: resetCycles.metrics[1]!.currentStart });
  fireEvent.click(screen.getByRole('radio', { name: '7 Days' }));
  expect(change.mock.lastCall?.[0]).toBe('7d');
  expect(screen.queryByRole('combobox', { name: 'Reset metric' })).toBeNull();
  open();
  expect(screen.getByRole('combobox', { name: 'Reset metric' }).textContent).toContain('7-day remaining');
});

it('enters an available cycle even when the first observed metric has insufficient history', () => {
  const { change } = renderControls({ ...resetCycles, metrics: [{ ...resetCycles.metrics[0]!, currentStart: null, previousStart: null }, resetCycles.metrics[1]!] });
  open();
  chooseCycle('Previous reset cycle');
  apply();
  expect(change.mock.lastCall?.[0]).toMatchObject({ cycle: 'previous', metric: resetCycles.metrics[1]!.identity });
});

it('lists unnamed observed metrics by their raw identities when display names collide', () => {
  const metrics = resetCycles.metrics.map((metric, index) => ({ ...metric, identity: { name: 'quota.utilization', labels: { quota: `unnamed_${index}` } }, display: { name: 'Unnamed', labelKey: null, windowSeconds: null } }));
  const { change } = renderControls({ ...resetCycles, metrics });
  open();
  chooseMetric('quota.utilization{quota="unnamed_1"}');
  apply();
  expect(change.mock.lastCall?.[0]).toMatchObject({ metric: metrics[1]!.identity });
});

it('explains missing reset observations inside the picker without changing calendar statistics', () => {
  const { change } = renderControls({ ...resetCycles, metrics: [{ ...resetCycles.metrics[0]!, currentStart: null, previousStart: null }] });
  open();
  expect(screen.getByText(/No reset recorded for this metric yet/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'View statistics' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('combobox', { name: 'Cycle' }));
  expect(screen.getByRole('option', { name: 'Current reset cycle' }).getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByRole('option', { name: 'Previous reset cycle' }).getAttribute('aria-disabled')).toBe('true');
  expect(change).not.toHaveBeenCalled();
});

it('offers the current cycle while explaining why the previous cycle is unavailable', () => {
  renderControls({ ...resetCycles, metrics: [{ ...resetCycles.metrics[0]!, previousStart: null }] });
  open();
  expect(screen.getByText(/A previous cycle needs two recorded resets/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'View statistics' }).hasAttribute('disabled')).toBe(false);
  fireEvent.click(screen.getByRole('combobox', { name: 'Cycle' }));
  expect(screen.getByRole('option', { name: 'Previous reset cycle' }).getAttribute('aria-disabled')).toBe('true');
});

it('discards canceled drafts and restores focus and polling when the picker closes', () => {
  const { change, editing } = renderControls();
  open();
  chooseMetric('7-day remaining');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(editing.mock.lastCall).toEqual([false]);
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'By cycle' }));
  expect(screen.getByRole('radio', { name: 'Last Day' }).getAttribute('aria-checked')).toBe('true');
  open();
  expect(screen.getByRole('combobox', { name: 'Reset metric' }).textContent).toContain('5-hour remaining');
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Choose reset cycle' }), { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Choose reset cycle' })).toBeNull();
  expect(editing.mock.lastCall).toEqual([false]);
  expect(change).not.toHaveBeenCalled();
});

it('dismisses on an outside click without applying a draft or leaving polling suspended', () => {
  const { change, editing } = renderControls();
  const outside = screen.getByRole('button', { name: 'Outside' });
  open();
  chooseMetric('7-day remaining');
  expect(screen.getByRole('dialog', { name: 'Choose reset cycle' })).toBeTruthy();
  fireEvent.mouseDown(outside);
  fireEvent.mouseUp(outside);
  fireEvent.click(outside);
  expect(screen.queryByRole('dialog', { name: 'Choose reset cycle' })).toBeNull();
  expect(editing.mock.lastCall).toEqual([false]);
  expect(change).not.toHaveBeenCalled();
});

it('preserves custom date selection while moving between calendar and cycle pickers', () => {
  const { change } = renderControls();
  open();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
  fireEvent.click(screen.getByRole('gridcell', { name: 'November 6, 2026' }));
  fireEvent.click(screen.getByRole('gridcell', { name: 'November 9, 2026' }));
  expect(change.mock.calls).toEqual([[{ start: '2026-11-06', end: '2026-11-09' }]]);
  open();
  chooseCycle('Previous reset cycle');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(change).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('radio', { name: 'Custom' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('button', { name: 'Choose date range' }).textContent).toContain('2026/11/06');
});
