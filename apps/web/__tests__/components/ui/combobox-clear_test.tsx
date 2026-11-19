import { fireEvent, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { Combobox } from '../../../src/components/ui/fluent-form-controls';
import { renderInApp } from '../../render';

test('keeps clear actions unavailable on disabled and read-only fields', () => {
  const onClear = vi.fn();
  const { rerender } = renderInApp(<Combobox aria-label="Filter" clearAction={{ label: 'Clear filter', onClear }} disabled value="alice" />);
  const clear = screen.getByRole<HTMLButtonElement>('button', { name: 'Clear filter' });
  expect(clear.disabled).toBe(true);
  fireEvent.click(clear);
  expect(onClear).not.toHaveBeenCalled();
  rerender(<Combobox aria-label="Filter" clearAction={{ label: 'Clear filter', onClear }} readOnly value="alice" />);
  expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull();
});
