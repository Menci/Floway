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

test('PageDown from January31 focuses the final day of February', () => {
  renderCalendar('2026-01-31');
  focusKey('PageDown');
  expect(focusedDate()).toBe('2026-02-28');
});

test('keyboard navigation clamps to the minimum date instead of displaying an empty month', () => {
  renderCalendar('1920-01-05');
  focusKey('ArrowUp');
  expect(focusedDate()).toBe('1920-01-01');
  focusKey('PageUp');
  expect(focusedDate()).toBe('1920-01-01');
  expect(screen.getByRole('button', { name: 'January 1920, choose a month' })).toBeTruthy();
});

test('End in the partial final century focuses its last enabled decade', () => {
  renderCalendar('2120-12-31');
  focusKey('ArrowUp', true); focusKey('ArrowUp', true); focusKey('ArrowUp', true);
  expect(fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp', ctrlKey: true })).toBe(false);
  focusKey('Home');
  expect(focusedDate()).toBe('2100-01-01');
  focusKey('End');
  expect(focusedDate()).toBe('2120-01-01');
  focusKey('PageDown');
  expect(focusedDate()).toBe('2120-01-01');
});

test('Ctrl+Down selects the focused day in month view', () => {
  const change = renderCalendar('2026-10-16');
  focusKey('ArrowDown', true);
  expect(change).toHaveBeenCalledWith({ start: '2026-10-16', end: null });
});

test('header arrow keys return focus to the current scope origin', () => {
  renderCalendar('2026-10-16');
  const header = screen.getByRole('button', { name: 'October 2026, choose a month' });
  header.focus(); focusKey('ArrowDown');
  expect(focusedDate()).toBe('2026-10-01');
});

test('a pending start on today retains the native single-selection paint state', () => {
  vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 9, 10, 12).getTime());
  renderInApp(<CalendarRange displayDate="2026-10-10" onChange={vi.fn()} value={{ start: '2026-10-10', end: null }} />);
  const today = screen.getByRole('gridcell', { name: 'October 10, 2026' });
  expect(today.hasAttribute('data-today')).toBe(true);
  expect(today.hasAttribute('data-single')).toBe(true);
});

test('arrow navigation keeps the header opaque and leaves an active drill running', () => {
  vi.mocked(window.matchMedia).mockImplementation(query => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => true } as MediaQueryList));
  const original = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');
  const animate = vi.fn(() => ({ cancel: vi.fn(), addEventListener: vi.fn() }) as unknown as Animation);
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate });
  try {
    renderCalendar('2026-10-16');
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(animate.mock.contexts.some(target => (target as HTMLElement).classList.contains('floway-range-heading'))).toBe(false);
    animate.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'November 2026, choose a month' }));
    const drill = animate.mock.results.filter((_, index) => (animate.mock.contexts[index] as HTMLElement).classList.contains('floway-range-view')).map(result => result.value as Animation);
    expect(drill).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Next year' }));
    for (const animation of drill) expect(animation.cancel).not.toHaveBeenCalled();
    expect(animate.mock.contexts.filter(target => (target as HTMLElement).classList.contains('floway-range-heading'))).toHaveLength(1);
  } finally {
    if (original) Object.defineProperty(Element.prototype, 'animate', original);
    else Reflect.deleteProperty(Element.prototype, 'animate');
  }
});
