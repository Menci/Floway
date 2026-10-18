import { ChevronDown12Regular } from '@fluentui/react-icons';
import { useState, type ReactNode } from 'react';

import { listboxRenderer, LISTBOX_POSITIONING, type ListboxRenderFunction } from './fluent-form-controls';
import { fluentComponents } from '../../fluent';

const { TagPicker, TagPickerControl, TagPickerGroup, TagPickerInput, TagPickerList, TagPickerOption } = fluentComponents;

export interface TagComboboxOption { value: string; label: string }

export function TagCombobox({ disabled, emptyMessage, label, onChange, options, placeholder, renderOption, renderTag, value }: {
  disabled?: boolean;
  emptyMessage: string;
  label: string;
  onChange: (value: string[]) => void;
  options: TagComboboxOption[];
  placeholder: string;
  renderOption: (option: TagComboboxOption) => ReactNode;
  renderTag: (option: TagComboboxOption) => ReactNode;
  value: string[];
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const visible = options.filter(option => !value.includes(option.value) && option.label.toLowerCase().includes(needle));
  const renderList: ListboxRenderFunction = (Component, props) => listboxRenderer(false, emptyMessage)(Component, {
    ...props,
    children: visible.map(option => <TagPickerOption key={option.value} text={option.label} value={option.value}>{renderOption(option)}</TagPickerOption>),
  });
  return <TagPicker
    disabled={disabled}
    onOpenChange={(_, data) => { if (!data.open) setQuery(''); }}
    onOptionSelect={(_, data) => { onChange(data.selectedOptions); setQuery(''); }}
    positioning={LISTBOX_POSITIONING}
    selectedOptions={value}
  >
    <TagPickerControl expandIcon={<ChevronDown12Regular />}>
      <TagPickerGroup aria-label={label}>
        {value.map(id => options.find(option => option.value === id)!).map(renderTag)}
      </TagPickerGroup>
      <TagPickerInput aria-label={label} autoComplete="off" data-query-empty={query.length === 0} onChange={event => setQuery(event.target.value)} placeholder={value.length === 0 ? placeholder : undefined} spellCheck={false} value={query} />
    </TagPickerControl>
    <TagPickerList>{renderList}</TagPickerList>
  </TagPicker>;
}
