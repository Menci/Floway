import { fireEvent, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { TimePicker } from '../../../src/components/ui/time-picker';
import { renderInApp } from '../../render';

test('an older scroll completion cannot replace a newly clicked time', async () => {
  const values = Array.from({ length: 24 }, (_, hour) => Date.UTC(2026, 9, 10, hour));
  const change = vi.fn();
  renderInApp(<TimePicker active label="Time" onChange={change} surfaceRef={() => {}} value={values[20]} values={values}><button type="button">Time</button></TimePicker>);
  fireEvent.click(screen.getByRole('button', { name: 'Time' }));
  const option = await screen.findByRole('option', { name: '23' });
  fireEvent.click(option);
  const wheel = screen.getByRole('listbox', { name: 'Hour' });
  const top = option.style.getPropertyValue('--floway-picker-item-top');
  const match = /\+ (\d+)px\)/.exec(top);
  expect(match).not.toBeNull();
  const target = Number(match![1]);
  wheel.scrollTop = target - 120;
  fireEvent(wheel, new Event('scrollend'));
  wheel.scrollTop = target - 80;
  fireEvent.scroll(wheel);
  wheel.scrollTop = target;
  fireEvent.scroll(wheel);
  fireEvent(wheel, new Event('scrollend'));
  fireEvent.click(screen.getByRole('button', { name: 'Accept time' }));
  expect(change.mock.calls).toEqual([[values[23]]]);
});
