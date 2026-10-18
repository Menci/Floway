import { fireEvent, screen } from '@testing-library/react';
import { createRef, useState } from 'react';
import { expect, test, vi } from 'vitest';

import { InlineCombobox } from '../../../src/components/ui/inline-combobox';
import { fluentComponents } from '../../../src/fluent';
import { renderInApp } from '../../render';

const { Option } = fluentComponents;

test('renders an intrinsic text mirror without an expander or another input', () => {
  const { container } = renderInApp(<InlineCombobox aria-label="Resource" emptyMessage="No resources" value="Upstream" />);
  expect(screen.getAllByRole('combobox')).toHaveLength(1);
  expect(screen.getByRole<HTMLInputElement>('combobox').value).toBe('Upstream');
  const mirror = container.querySelector('[data-inline-combobox-mirror]')!;
  expect(mirror.textContent).toBe('Upstream');
  expect(mirror.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelector('.fui-Combobox__expandIcon')).toBeNull();
});

test('updates its text mirror as the controlled input changes', () => {
  function Editor() {
    const [value, setValue] = useState('User');
    return <InlineCombobox aria-label="Resource" emptyMessage="No resources" onChange={event => setValue(event.target.value)} value={value} />;
  }
  const { container } = renderInApp(<Editor />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Upstream' } });
  expect(container.querySelector('[data-inline-combobox-mirror]')!.textContent).toBe('Upstream');
});

test('lays out the native input inside the shared trimmed text box', () => {
  const ref = createRef<HTMLInputElement>();
  const { container } = renderInApp(<InlineCombobox aria-label="Resource" emptyMessage="No resources" ref={ref} value="Upstream" />);
  const input = screen.getByRole<HTMLInputElement>('combobox');
  const mirror = container.querySelector('[data-inline-combobox-mirror]')!;
  expect(ref.current).toBe(input);
  expect(input.parentElement!.classList.contains('floway-control-label')).toBe(true);
  expect(mirror.classList.contains('floway-control-label')).toBe(true);
  expect(input.parentElement!.parentElement).toBe(mirror.parentElement);
  expect(getComputedStyle(input).display).toBe('inline-block');
  expect(getComputedStyle(input).lineHeight).toBe('normal');
  expect(input.style.transform).toBe('');
});

test('retains Fluent option selection and the shared scrollable dropdown', () => {
  const select = vi.fn();
  renderInApp(<InlineCombobox aria-label="Resource" defaultOpen emptyMessage="No resources" onOptionSelect={select} value="">
    <Option value="user">User</Option>
    <Option value="upstream">Upstream</Option>
  </InlineCombobox>);
  expect(screen.getByRole('listbox').querySelector('.floway-combobox-listbox-viewport')).toBeTruthy();
  fireEvent.click(screen.getByRole('option', { name: 'Upstream' }));
  expect(select.mock.lastCall![1].optionValue).toBe('upstream');
});
