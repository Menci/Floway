import { fireEvent, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { Combobox, Dropdown } from '../../../src/components/ui/fluent-form-controls';
import { selectCss } from '../../../src/winui/controls/select.css';
import { renderInApp } from '../../render';

test('exposes an independent clear button without replacing the disclosure arrow', () => {
  const onClear = vi.fn();
  const { container } = renderInApp(<Combobox aria-label="Filter" clearAction={{ label: 'Clear filter', onClear }} selectedOptions={['alice']} value="alice" />);
  const clear = screen.getByRole('button', { name: 'Clear filter' });
  expect(clear.tagName).toBe('BUTTON');
  expect(clear.getAttribute('type')).toBe('button');
  expect(container.querySelector('.fui-Combobox__expandIcon')).toBeTruthy();
  expect(clear.querySelector('svg')!.style.width).toBe('12px');
  expect(clear.querySelector('svg')!.style.height).toBe('12px');
  fireEvent.click(clear);
  expect(onClear).toHaveBeenCalledOnce();
});

test.each([Combobox, Dropdown])('uses 12px artwork for default clearable select fields', Control => {
  const { container } = renderInApp(<Control aria-label="Filter" clearable selectedOptions={['alice']} value="alice" />);
  const icon = container.querySelector<SVGElement>('.fui-Combobox__clearIcon svg, .fui-Dropdown__clearButton svg')!;
  expect(icon.style.width).toBe('12px');
  expect(icon.style.height).toBe('12px');
  expect(icon.getAttribute('viewBox')).toBe('0 0 12 12');
});

test('preserves explicit suppression of clear slots', () => {
  const { container, rerender } = renderInApp(<Combobox aria-label="Filter" clearable clearIcon={null} selectedOptions={['alice']} value="alice" />);
  expect(container.querySelector('.fui-Combobox__clearIcon')).toBeNull();
  rerender(<Dropdown aria-label="Filter" clearable clearButton={null} selectedOptions={['alice']} value="alice" />);
  expect(container.querySelector('.fui-Dropdown__clearButton')).toBeNull();
});

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

test('allocates an independent third track for the clear button', () => {
  const style = document.createElement('style');
  style.textContent = selectCss;
  document.head.append(style);
  try {
    const { container } = renderInApp(<Combobox aria-label="Filter" clearAction={{ label: 'Clear filter', onClear: vi.fn() }} value="alice" />);
    expect(getComputedStyle(container.querySelector('.fui-Combobox')!).gridTemplateColumns).toBe('minmax(0, 1fr) auto auto');
  } finally {
    style.remove();
  }
});
