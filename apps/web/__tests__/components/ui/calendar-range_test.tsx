import { fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { CalendarRange } from '../../../src/components/ui/calendar-range';
import { renderInApp } from '../../render';

afterEach(() => vi.restoreAllMocks());

test('all four native views hide outside dates and transfer focus before disabling the last heading', () => {
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query === '(prefers-reduced-motion: reduce)', media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => true } as MediaQueryList));
  const change = vi.fn();
  renderInApp(<CalendarRange displayDate="2026-10-16" onChange={change} value={{ start: '2026-10-06', end: '2026-10-16' }} />);
  expect(screen.getAllByRole('gridcell')).toHaveLength(31);
  const monthHeading = screen.getByRole('button', { name: 'October 2026, choose a month' });
  monthHeading.focus(); fireEvent.click(monthHeading);
  expect(screen.getAllByRole('gridcell')).toHaveLength(12);
  expect(document.activeElement).toBe(monthHeading);
  fireEvent.click(screen.getByRole('button', { name: '2026, choose a year' }));
  expect(screen.getAllByRole('gridcell')).toHaveLength(10);
  fireEvent.click(screen.getByRole('button', { name: '2020-2029, choose a year' }));
  expect(screen.getAllByRole('gridcell')).toHaveLength(10);
  expect((document.activeElement as HTMLElement).dataset.date).toBe('2020-01-01');
  fireEvent.click(screen.getByRole('gridcell', { name: '2020-2029' }));
  fireEvent.click(screen.getByRole('gridcell', { name: '2026' }));
  fireEvent.click(screen.getByRole('gridcell', { name: 'Oct' }));
  expect(screen.getAllByRole('gridcell')).toHaveLength(31);
  expect(document.activeElement?.getAttribute('role')).toBe('gridcell');
  expect(change).not.toHaveBeenCalled();
});
