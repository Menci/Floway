import { fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';

import { dashboardInterval, type DashboardRange } from '../../../src/components/charts/dashboard-time';
import { TelemetryTimeRange } from '../../../src/components/telemetry/time-range';
import { renderInApp } from '../../render';

const now = Date.UTC(2026, 9, 10, 14, 30);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const renderEditor = () => {
  vi.stubEnv('TZ', 'UTC');
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const change = vi.fn<(range: DashboardRange) => void>();
  const editing = vi.fn();
  const router = createMemoryRouter([{
    path: '/',
    Component: () => <>
      <TelemetryTimeRange addressOf={() => '/'} ariaLabel="Range" loadedAt={now} onChange={change} onEditingChange={editing} range="today" />
      <button type="button">Outside</button>
    </>,
  }]);
  renderInApp(<RouterProvider router={router} />);
  return { change, editing };
};
const openEndpoint = (name: string) => {
  const button = screen.getByRole('button', { name });
  button.focus(); fireEvent.click(button);
};
const chooseDay = (day: number) => fireEvent.click(screen.getByRole('gridcell', { name: new RegExp(`^${  day  }(, today)?$`) }));

test('calendar dates and portalled time wheels form one commit group', async () => {
  const { change } = renderEditor();
  openEndpoint('Start time');
  chooseDay(8);
  expect(change).not.toHaveBeenCalled();
  const time = screen.getByRole('button', { name: 'Start time: Time' });
  time.focus(); fireEvent.click(time);
  const option = await screen.findByRole('option', { name: '12' });
  fireEvent.mouseDown(option); fireEvent.click(option);
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Accept time' }));
  openEndpoint('End time');
  chooseDay(9);
  expect(change).not.toHaveBeenCalled();
  screen.getByRole('button', { name: 'Outside' }).focus();
  await waitFor(() => expect(change).toHaveBeenCalledTimes(1));
  expect(change).toHaveBeenCalledWith({ start: Date.UTC(2026, 9, 8, 12), end: Date.UTC(2026, 9, 9, 15) });
});

test('cancelling the inner time picker preserves the complete draft without fetching', async () => {
  const { change } = renderEditor();
  openEndpoint('Start time');
  const time = screen.getByRole('button', { name: 'Start time: Time' });
  time.focus(); fireEvent.click(time);
  fireEvent.click(await screen.findByRole('option', { name: '12' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  screen.getByRole('button', { name: 'Outside' }).focus();
  await Promise.resolve();
  expect(change).not.toHaveBeenCalled();
});

test('reversed endpoints retain the loaded query and report an error', async () => {
  const { change } = renderEditor();
  openEndpoint('Start time');
  chooseDay(11);
  screen.getByRole('button', { name: 'Outside' }).focus();
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('later than'));
  expect(change).not.toHaveBeenCalled();
});

test('preset activation replaces the draft without an intermediate custom query', () => {
  const { change } = renderEditor();
  openEndpoint('Start time');
  chooseDay(8);
  const preset = screen.getByRole('radio', { name: '7 Days' });
  preset.focus(); fireEvent.click(preset);
  expect(change.mock.calls).toEqual([['7d']]);
});

test('an untouched editor catches up its live preset across an hour boundary', async () => {
  const { change } = renderEditor();
  openEndpoint('Start time');
  vi.mocked(Date.now).mockReturnValue(now + 3_600_000);
  screen.getByRole('button', { name: 'Outside' }).focus();
  await Promise.resolve();
  expect(change.mock.calls).toEqual([['today']]);
  expect(dashboardInterval('today', now).end).not.toBe(dashboardInterval('today', Date.now()).end);
});

test('time wheel dismissal discards pending time while retaining a calendar draft', async () => {
  const { change } = renderEditor();
  openEndpoint('Start time');
  chooseDay(8);
  const time = screen.getByRole('button', { name: 'Start time: Time' });
  time.focus(); fireEvent.click(time);
  fireEvent.click(await screen.findByRole('option', { name: '12' }));
  expect(screen.getByRole('button', { name: 'Start time' }).textContent).toContain('15:00');
  fireEvent.keyDown(screen.getByRole('listbox', { name: 'Hour' }), { key: 'Escape' });
  await waitFor(() => expect(document.activeElement).toBe(time));
  screen.getByRole('button', { name: 'Outside' }).focus();
  await waitFor(() => expect(change.mock.calls).toEqual([[{ start: Date.UTC(2026, 9, 8, 15), end: Date.UTC(2026, 9, 10, 15) }]]));
});

test('time wheel keyboard navigation confirms from either column', async () => {
  const { change } = renderEditor();
  openEndpoint('Start time');
  const time = screen.getByRole('button', { name: 'Start time: Time' });
  time.focus(); fireEvent.click(time);
  const hours = await screen.findByRole('listbox', { name: 'Hour' });
  fireEvent.keyDown(hours, { key: 'Home' });
  fireEvent.keyDown(hours, { key: 'ArrowDown' });
  fireEvent.keyDown(hours, { key: 'ArrowRight' });
  const minutes = screen.getByRole('listbox', { name: 'Minute' });
  expect(document.activeElement).toBe(minutes);
  fireEvent.keyDown(minutes, { key: 'Enter' });
  await waitFor(() => expect(document.activeElement).toBe(time));
  expect(change).not.toHaveBeenCalled();
  screen.getByRole('button', { name: 'Outside' }).focus();
  await waitFor(() => expect(change.mock.calls).toEqual([[{ start: Date.UTC(2026, 9, 9, 1), end: Date.UTC(2026, 9, 10, 15) }]]));
});

test('clock hour and AM/PM changes remain drafts until the complete editor loses focus', async () => {
  const { change } = renderEditor();
  openEndpoint('Start time');
  fireEvent.click(screen.getByRole('radio', { name: 'Hour 4' }));
  expect(screen.getByRole('button', { name: 'Start time: Time' }).textContent).toBe('16:00:00');
  const am = screen.getByRole('radio', { name: 'am' });
  am.focus(); fireEvent.click(am);
  expect(screen.getByRole('button', { name: 'Start time: Time' }).textContent).toBe('04:00:00');
  expect(document.activeElement).toBe(am);
  expect(change).not.toHaveBeenCalled();
  screen.getByRole('button', { name: 'Outside' }).focus();
  await waitFor(() => expect(change.mock.calls).toEqual([[{ start: Date.UTC(2026, 9, 9, 4), end: Date.UTC(2026, 9, 10, 15) }]]));
});
