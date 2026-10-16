import { ChevronDown12Regular } from '@fluentui/react-icons';
import { useState, type ReactNode } from 'react';

import { LISTBOX_POSITIONING } from './fluent-form-controls';
import { fluentComponents } from '../../fluent';

const { TagPicker, TagPickerControl, TagPickerGroup, TagPickerInput, TagPickerList, TagPickerOption, Text } = fluentComponents;

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
  return <TagPicker
    disabled={disabled}
    onOpenChange={(_, data) => { if (!data.open) setQuery(''); }}
    onOptionSelect={(_, data) => { onChange(data.selectedOptions); setQuery(''); }}
    positioning={LISTBOX_POSITIONING}
    selectedOptions={value}
  >
    <TagPickerControl expandIcon={<ChevronDown12Regular />}>
      <TagPickerGroup aria-label={label} className="gap-1.5 min-w-0">
        {value.map(id => options.find(option => option.value === id)!).map(renderTag)}
      </TagPickerGroup>
      <TagPickerInput aria-label={label} onChange={event => setQuery(event.target.value)} placeholder={value.length === 0 ? placeholder : undefined} value={query} />
    </TagPickerControl>
    <TagPickerList>
      {visible.length === 0
        ? <Text className="text-fui-fg2 px-3 py-2" role="status">{emptyMessage}</Text>
        : visible.map(option => <TagPickerOption key={option.value} text={option.label} value={option.value}>{renderOption(option)}</TagPickerOption>)}
    </TagPickerList>
  </TagPicker>;
}
