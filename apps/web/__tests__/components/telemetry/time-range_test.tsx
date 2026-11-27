import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';

import { resetHistory } from './reset-fixture';
import type { DashboardRange } from '../../../src/components/charts/dashboard-time';
import { resetRangeAt, type ResetCycleHistory } from '../../../src/components/telemetry/reset-cycles';
import { TelemetryTimeRange } from '../../../src/components/telemetry/time-range';
import { renderInApp } from '../../render';

const now = Date.UTC(2026, 9, 10, 14, 30);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const renderEditor = (initial: DashboardRange = 'today', resetCycles: ResetCycleHistory | null = null) => {
  vi.stubEnv('TZ', 'UTC');
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query === '(prefers-reduced-motion: reduce)', media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => true } as MediaQueryList));
  if (resetCycles !== null) vi.stubGlobal('fetch', vi.fn(async () => Response.json(resetCycles)));
  const change = vi.fn<(range: DashboardRange) => void>();
  const editing = vi.fn();
  let commitLoaded!: Dispatch<SetStateAction<DashboardRange>>;
  const router = createMemoryRouter([{
    path: '/',
    Component: () => {
      const [range, setRange] = useState(initial);
      commitLoaded = setRange;
      return <>
        <TelemetryTimeRange addressOf={() => '/'} ariaLabel="Range" loadedAt={now} onChange={change} onEditingChange={editing} range={range} resetUpstreamId={resetCycles?.upstreamId ?? null} />
        <button type="button">Outside</button>
      </>;
    },
  }]);
  renderInApp(<RouterProvider router={router} />);
  return { change, editing, commit: (range: DashboardRange) => act(() => commitLoaded(range)) };
};
const open = () => { const custom = screen.getByRole('radio', { name: 'Custom' }); custom.focus(); fireEvent.click(custom); };
const day = (value: number) => fireEvent.click(screen.getByRole('gridcell', { name: `October ${value}, 2026` }));
const outside = () => screen.getByRole('button', { name: 'Outside' }).focus();

test('only Custom opens a day range and the second date closes and applies once', async () => {
  const { change } = renderEditor();
  expect(screen.queryByRole('button', { name: 'Choose date range' })).toBeNull();
  open(); day(6);
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole('grid')).toBeTruthy();
  day(16);
  expect(screen.queryByRole('grid')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Custom' }));
  outside();
  await waitFor(() => expect(change.mock.calls).toEqual([[{ start: '2026-10-06', end: '2026-10-16' }]]));
  expect(screen.queryByRole('button', { name: 'Choose date range' })).toBeNull();
});

test('browses earlier cycles and switches quota windows before applying the displayed time span', async () => {
  const history = resetHistory(now);
  const { change, editing } = renderEditor('today', history);
  const trigger = await screen.findByRole('radio', { name: 'By Reset Cycle' });
  trigger.focus();
  fireEvent.click(trigger);
  expect(await screen.findByText('Current cycle')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Newer cycle' }).getAttribute('aria-disabled')).toBe('true');
  const older = screen.getByRole('button', { name: 'Older cycle' });
  fireEvent.click(older);
  expect(screen.getByText('Previous cycle')).toBeTruthy();
  fireEvent.click(older);
  expect(screen.getByText('2 cycles ago')).toBeTruthy();
  fireEvent.click(older);
  expect(older.getAttribute('aria-disabled')).toBe('true');
  expect(change).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('combobox', { name: 'Quota window' }));
  fireEvent.click(screen.getByRole('option', { name: '7-day remaining' }));
  expect(screen.getByText('Current cycle')).toBeTruthy();
  fireEvent.click(older);
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(change.mock.calls).toEqual([[resetRangeAt(history.upstreamId, history.metrics[1]!, 1)]]));
  expect(screen.queryByRole('dialog', { name: 'Choose reset cycle' })).toBeNull();
  expect(editing.mock.calls).toEqual([[true], [false]]);
  expect(document.activeElement).toBe(trigger);
});

test('offers no date range until a refill has been observed', async () => {
  const { change } = renderEditor('today', { ...resetHistory(now), metrics: [] });
  fireEvent.click(await screen.findByRole('radio', { name: 'By Reset Cycle' }));
  expect(await screen.findByText('No quota resets observed yet')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Apply' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(change).not.toHaveBeenCalled();
});
