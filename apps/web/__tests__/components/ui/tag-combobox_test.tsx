import { act, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, test } from 'vitest';

import { TagCombobox } from '../../../src/components/ui/tag-combobox';
import { fluentComponents } from '../../../src/fluent';
import { tagPickerCss } from '../../../src/winui/controls/tag-picker.css';
import { textInputCss } from '../../../src/winui/controls/text-input.css';
import { renderInApp } from '../../render';

const { Tag } = fluentComponents;
const options = ['Alpha', 'Beta', 'Gamma'].map(label => ({ label, value: label }));

function Picker({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState(['Alpha', 'Beta']);
  return <TagCombobox
    disabled={disabled} emptyMessage="No matches" label="Values" onChange={setValue} options={options} placeholder="Search values"
    renderOption={option => option.label}
    renderTag={option => <Tag dismissIcon={{ 'aria-label': `Remove ${option.label}` }} key={option.value} value={option.value}>{option.label}</Tag>}
    value={value}
  />;
}

test('keeps the same input when the last selected tag and listbox disappear', async () => {
  const stylesheet = document.createElement('style');
  stylesheet.textContent = textInputCss + tagPickerCss;
  document.head.append(stylesheet);
  try {
    const { container } = renderInApp(<Picker />);
    const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Values' });
    const group = container.querySelector('.fui-TagPickerGroup')!;
    expect(group.getAttribute('role')).toBe('listbox');
    expect(getComputedStyle(group).display).toBe('contents');
    expect(getComputedStyle(input).minHeight).toBe('28px');
    expect(Number.parseFloat(getComputedStyle(input).flexBasis)).toBe(0);
    await act(async () => { fireEvent.click(screen.getByLabelText('Remove Alpha')); });
    await act(async () => { fireEvent.click(screen.getByLabelText('Remove Beta')); });
    expect(container.querySelector('.fui-TagPickerGroup')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Values' })).toBe(input);
    expect(input.placeholder).toBe('Search values');
    expect(getComputedStyle(input.closest('.fui-TagPickerControl')!).minHeight).toBe('34px');
  } finally { stylesheet.remove(); }
});

test('resets the empty-query layout when filtering is dismissed', async () => {
  renderInApp(<Picker />);
  const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Values' });
  expect(input.getAttribute('data-query-empty')).toBe('true');
  await act(async () => { fireEvent.click(input); fireEvent.change(input, { target: { value: 'Gam' } }); });
  expect(input.value).toBe('Gam');
  expect(input.getAttribute('data-query-empty')).toBe('false');
  await act(async () => { fireEvent.keyDown(input, { key: 'Escape' }); });
  expect(input.value).toBe('');
  expect(input.getAttribute('data-query-empty')).toBe('true');
});

test('keeps disabled tag removal and input unavailable', () => {
  const { container } = renderInApp(<Picker disabled />);
  expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Values' }).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('Remove Alpha'));
  expect(container.querySelectorAll('.fui-Tag')).toHaveLength(2);
});
