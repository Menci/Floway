import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';

import type { DashboardRange } from '../../../src/components/charts/dashboard-time';
import { TelemetryTimeRange } from '../../../src/components/telemetry/time-range';
import { renderInApp } from '../../render';

const now = Date.UTC(2026, 9, 10, 14, 30);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const renderEditor = (initial: DashboardRange = 'today') => {
  vi.stubEnv('TZ', 'UTC');
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query === '(prefers-reduced-motion: reduce)', media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => true } as MediaQueryList));
  const change = vi.fn<(range: DashboardRange) => void>();
  const editing = vi.fn();
  let commitLoaded!: Dispatch<SetStateAction<DashboardRange>>;
  const router = createMemoryRouter([{
    path: '/',
    Component: () => {
      const [range, setRange] = useState(initial);
      commitLoaded = setRange;
      return <>
        <TelemetryTimeRange addressOf={() => '/'} ariaLabel="Range" loadedAt={now} onChange={change} onEditingChange={editing} range={range} />
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

test('only Custom opens a day range and a complete range applies on group blur', async () => {
  const { change } = renderEditor();
  expect(screen.queryByRole('button', { name: 'Choose date range' })).toBeNull();
  open(); day(6); day(16);
  expect(change).not.toHaveBeenCalled();
  outside();
  await waitFor(() => expect(change.mock.calls).toEqual([[{ start: '2026-10-06', end: '2026-10-16' }]]));
  expect(screen.queryByRole('button', { name: 'Choose date range' })).toBeNull();
});

test('the date caption appears only after a successful load and both entries reopen the same picker', async () => {
  const { commit } = renderEditor();
  open(); day(6); day(16); outside();
  await waitFor(() => expect(screen.queryByRole('grid')).toBeNull());
  expect(screen.queryByRole('button', { name: 'Choose date range' })).toBeNull();
  commit({ start: '2026-10-06', end: '2026-10-16' });
  const caption = screen.getByRole('button', { name: 'Choose date range' });
  expect(caption.textContent).toBe('2026/10/06 - 2026/10/16');
  expect(caption.compareDocumentPosition(screen.getByRole('radiogroup')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  caption.focus(); fireEvent.click(caption);
  expect(screen.getByRole('grid')).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('grid'), { key: 'Escape' });
  open();
  expect(screen.getByRole('grid')).toBeTruthy();
});

test('an incomplete range or Escape keeps the loaded preset', async () => {
  const { change } = renderEditor();
  open(); day(8); outside();
  await Promise.resolve();
  expect(change).not.toHaveBeenCalled();
  open(); day(8); day(9);
  fireEvent.keyDown(screen.getByRole('grid'), { key: 'Escape' });
  expect(change).not.toHaveBeenCalled();
});

test('preset activation discards a draft without an intermediate custom query', () => {
  const { change } = renderEditor();
  open(); day(8); day(9);
  const preset = screen.getByRole('radio', { name: '7 Days' });
  preset.focus(); fireEvent.click(preset);
  expect(change.mock.calls).toEqual([['7d']]);
});

test('the native range semantics sort reversed clicks and allow the same day', async () => {
  const { change } = renderEditor();
  open(); day(16); day(6); outside();
  await waitFor(() => expect(change).toHaveBeenCalledWith({ start: '2026-10-06', end: '2026-10-16' }));
  open(); day(8); day(8); outside();
  await waitFor(() => expect(change).toHaveBeenCalledWith({ start: '2026-10-08', end: '2026-10-08' }));
});

test('clicking within the selected range clears it without replacing loaded data', async () => {
  const { change } = renderEditor({ start: '2026-10-06', end: '2026-10-16' });
  open(); day(10); outside();
  await Promise.resolve();
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Choose date range' }).textContent).toContain('2026/10/06');
});

test('switching to a loaded preset removes the date caption immediately', () => {
  const { commit } = renderEditor({ start: '2026-10-06', end: '2026-10-16' });
  expect(screen.getByRole('button', { name: 'Choose date range' })).toBeTruthy();
  commit('7d');
  expect(screen.queryByRole('button', { name: 'Choose date range' })).toBeNull();
});
