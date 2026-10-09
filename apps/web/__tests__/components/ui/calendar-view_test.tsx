import { fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { CalendarView } from '../../../src/components/ui/calendar-view';
import { renderInApp } from '../../render';

afterEach(() => vi.restoreAllMocks());

const renderCalendar = (value: Date, minDate = new Date(1924, 0, 1), maxDate = new Date(2124, 11, 31)) => {
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query === '(prefers-reduced-motion: reduce)', media: query } as MediaQueryList));
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(294);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(296);
  renderInApp(<CalendarView maxDate={maxDate} minDate={minDate} onSelectDate={vi.fn()} value={value} />);
};

test('calendar navigation stops when the visible rows already contain the date bounds', () => {
  renderCalendar(new Date(2026, 0, 15), new Date(2026, 0, 1), new Date(2026, 1, 2));
  expect((screen.getByRole('button', { name: 'Previous month' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Next month' }) as HTMLButtonElement).disabled).toBe(true);
});

test('calendar item drilling transfers focus while header drilling retains it', () => {
  renderCalendar(new Date(2026, 9, 9));
  const heading = screen.getByRole('button', { name: 'October 2026, choose a month' });
  heading.focus(); fireEvent.click(heading);
  expect(document.activeElement).toBe(heading);
  const month = screen.getByRole('gridcell', { name: 'September' });
  month.focus(); fireEvent.click(month);
  expect(document.activeElement?.getAttribute('role')).toBe('gridcell');
  expect(document.activeElement?.textContent).toBe('9');
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp', ctrlKey: true });
  expect(document.activeElement?.getAttribute('aria-label')).toBe('September');
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', ctrlKey: true });
  expect(document.activeElement?.textContent).toBe('9');
});
