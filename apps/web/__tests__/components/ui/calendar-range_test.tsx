import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { CalendarRange } from '../../../src/components/ui/calendar-range';
import { renderInApp } from '../../render';

beforeEach(() => {
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query === '(prefers-reduced-motion: reduce)', media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => true } as MediaQueryList));
});
afterEach(() => vi.restoreAllMocks());

test('all four native views hide outside dates and transfer focus before disabling the last heading', () => {
  const change = vi.fn();
  renderInApp(<CalendarRange displayDate="2026-10-16" onChange={change} value={{ start: '2026-10-06', end: '2026-10-16' }} />);
  expect(screen.getAllByRole('gridcell')).toHaveLength(31);
  const monthHeading = screen.getByRole('button', { name: 'October 2026, choose a month' });
  monthHeading.focus(); fireEvent.click(monthHeading);
  expect(screen.getAllByRole('gridcell')).toHaveLength(12);
  expect(document.activeElement).toBe(monthHeading);
  fireEvent.click(screen.getByRole('button', { name: '2026, choose a year' }));
  expect(screen.getAllByRole('gridcell')).toHaveLength(10);
  fireEvent.click(screen.getByRole('button', { name: '2020 - 2029, choose a decade' }));
  expect(screen.getAllByRole('gridcell')).toHaveLength(10);
  expect((screen.getByRole('button', { name: '2000 - 2099' }) as HTMLButtonElement).disabled).toBe(true);
  expect((document.activeElement as HTMLElement).dataset.date).toBe('2020-01-01');
  fireEvent.click(screen.getByRole('gridcell', { name: '2020-2029' }));
  fireEvent.click(screen.getByRole('gridcell', { name: '2026' }));
  fireEvent.click(screen.getByRole('gridcell', { name: 'Oct' }));
  expect(screen.getAllByRole('gridcell')).toHaveLength(31);
  expect(document.activeElement?.getAttribute('role')).toBe('gridcell');
  expect(change).not.toHaveBeenCalled();
});

const renderCalendar = (displayDate: string) => {
  const change = vi.fn();
  renderInApp(<CalendarRange autoFocus displayDate={displayDate} onChange={change} value={{ start: null, end: null }} />);
  return change;
};
const focusedDate = () => (document.activeElement as HTMLElement).dataset.date;
const focusKey = (key: string, ctrlKey = false) => fireEvent.keyDown(document.activeElement!, { key, ctrlKey });

test('Page keys preserve the focused date and clamp short months', () => {
  renderCalendar('2026-10-16');
  focusKey('PageDown');
  expect(focusedDate()).toBe('2026-11-16');
  focusKey('PageUp');
  expect(focusedDate()).toBe('2026-10-16');
  focusKey('ArrowUp', true);
  expect(focusedDate()).toBe('2026-10-01');
  focusKey('PageDown');
  expect(focusedDate()).toBe('2027-10-01');
});

test('keyboard navigation clamps to the minimum date instead of displaying an empty month', () => {
  renderCalendar('1920-01-05');
  focusKey('ArrowUp');
  expect(focusedDate()).toBe('1920-01-01');
  focusKey('PageUp');
  expect(focusedDate()).toBe('1920-01-01');
  expect(screen.getByRole('button', { name: 'January 1920, choose a month' })).toBeTruthy();
});
