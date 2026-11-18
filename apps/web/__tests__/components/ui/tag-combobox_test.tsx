import { act, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, test } from 'vitest';

import { TagCombobox } from '../../../src/components/ui/tag-combobox';
import { fluentComponents } from '../../../src/fluent';
import { renderInApp } from '../../render';

const { Tag } = fluentComponents;
const options = ['Alpha', 'Beta', 'Gamma'].map(label => ({ label, value: label }));

function Picker() {
  const [value, setValue] = useState(['Alpha', 'Beta']);
  return <TagCombobox
    emptyMessage="No matches" label="Values" onChange={setValue} options={options} placeholder="Search values"
    renderOption={option => option.label}
    renderTag={option => <Tag dismissIcon={{ 'aria-label': `Remove ${option.label}` }} key={option.value} value={option.value}>{option.label}</Tag>}
    value={value}
  />;
}

test('keeps the same input when the last selected tag and listbox disappear', async () => {
  renderInApp(<Picker />);
  const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Values' });
  await act(async () => { fireEvent.click(screen.getByLabelText('Remove Alpha')); });
  await act(async () => { fireEvent.click(screen.getByLabelText('Remove Beta')); });
  expect(screen.getByRole('combobox', { name: 'Values' })).toBe(input);
  expect(input.placeholder).toBe('Search values');
});
