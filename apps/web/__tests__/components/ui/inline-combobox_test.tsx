import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';

import { InlineCombobox } from '../../../src/components/ui/inline-combobox';
import { fluentComponents } from '../../../src/fluent';
import { renderInApp } from '../../render';

const { Option } = fluentComponents;

test('updates its text mirror as the controlled input changes', () => {
  function Editor() {
    const [value, setValue] = useState('User');
    return <InlineCombobox aria-label="Resource" emptyMessage="No resources" onChange={event => setValue(event.target.value)} value={value} />;
  }
  const { container } = renderInApp(<Editor />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Upstream' } });
  expect(container.querySelector('[data-inline-combobox-mirror]')!.textContent).toBe('Upstream');
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
