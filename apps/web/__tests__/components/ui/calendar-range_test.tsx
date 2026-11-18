import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { CalendarRange } from '../../../src/components/ui/calendar-range';
import { renderInApp } from '../../render';

beforeEach(() => {
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query === '(prefers-reduced-motion: reduce)', media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => true } as MediaQueryList));
});
afterEach(() => vi.restoreAllMocks());

const renderCalendar = (displayDate: string) => {
  const change = vi.fn();
  renderInApp(<CalendarRange autoFocus displayDate={displayDate} onChange={change} value={{ start: null, end: null }} />);
  return change;
};
const focusedDate = () => (document.activeElement as HTMLElement).dataset.date;
const focusKey = (key: string, ctrlKey = false) => fireEvent.keyDown(document.activeElement!, { key, ctrlKey });

test('keyboard navigation clamps to the minimum date instead of displaying an empty month', () => {
  renderCalendar('1920-01-05');
  focusKey('ArrowUp');
  expect(focusedDate()).toBe('1920-01-01');
  focusKey('PageUp');
  expect(focusedDate()).toBe('1920-01-01');
  expect(screen.getByRole('button', { name: 'January 1920, choose a month' })).toBeTruthy();
});
