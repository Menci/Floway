import { fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';

import { dashboardInterval, type DashboardRange } from '../../../src/components/charts/dashboard-time';
import { TelemetryTimeRange } from '../../../src/components/telemetry/time-range';
import { renderInApp } from '../../render';

const now = Date.UTC(2026, 9, 10, 14, 30);
afterEach(() => vi.restoreAllMocks());

const renderEditor = () => {
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
  button.focus();
  fireEvent.click(button);
};

test('dates and portalled time options form one commit group', async () => {
  const { change } = renderEditor();
  openEndpoint('Start time');
  const date = screen.getByRole('textbox', { name: 'Start time: Date' });
  date.focus();
  fireEvent.change(date, { target: { value: '2026/10/08' } });
  expect(change).not.toHaveBeenCalled();

  const time = screen.getByRole('combobox', { name: 'Start time: Time' });
  time.focus();
  fireEvent.click(time);
  const option = await screen.findByRole('option', { name: '12:00' });
  await Promise.resolve();
  expect(change).not.toHaveBeenCalled();
  fireEvent.mouseDown(option);
  fireEvent.click(screen.getByRole('option', { name: '12:00' }));
  expect(screen.getByRole('combobox', { name: 'Start time: Time' }).textContent).toContain('12:00');

  openEndpoint('End time');
  const endDate = screen.getByRole('textbox', { name: 'End time: Date' });
  endDate.focus();
  fireEvent.change(endDate, { target: { value: '2026/10/09' } });
  expect(change).not.toHaveBeenCalled();
  screen.getByRole('button', { name: 'Outside' }).focus();
  await waitFor(() => expect(change).toHaveBeenCalledTimes(1));
  expect(change).toHaveBeenCalledWith({ start: Date.UTC(2026, 9, 8, 12), end: Date.UTC(2026, 9, 9, 15) });
});

test('incomplete date input cannot commit a partially edited interval', async () => {
  const { change } = renderEditor();
  openEndpoint('Start time');
  const date = screen.getByRole('textbox', { name: 'Start time: Date' });
  date.focus();
  fireEvent.change(date, { target: { value: '2026/10/' } });
  screen.getByRole('button', { name: 'Outside' }).focus();
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('valid date'));
  expect(change).not.toHaveBeenCalled();
});

test('reversed endpoints retain the loaded query and report an error', async () => {
  const { change } = renderEditor();
  openEndpoint('Start time');
  const date = screen.getByRole('textbox', { name: 'Start time: Date' });
  date.focus();
  fireEvent.change(date, { target: { value: '2026/10/11' } });
  screen.getByRole('button', { name: 'Outside' }).focus();
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('later than'));
  expect(change).not.toHaveBeenCalled();
});

test('preset activation replaces the draft without an intermediate custom query', () => {
  const { change } = renderEditor();
  openEndpoint('Start time');
  const date = screen.getByRole('textbox', { name: 'Start time: Date' });
  date.focus();
  fireEvent.change(date, { target: { value: '2026/10/08' } });
  const preset = screen.getByRole('radio', { name: '7 Days' });
  preset.focus();
  fireEvent.click(preset);
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
