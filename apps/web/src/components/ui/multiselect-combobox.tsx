import { useState } from 'react';
import type { ReactNode } from 'react';

import { Combobox } from './fluent-form-controls';
import { fluentComponents } from '../../fluent';

const { Option } = fluentComponents;

export interface MultiselectOption {
  value: string;
  label: string;
}

const sameValues = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && new Set(right).size === right.length && left.every(entry => right.includes(entry));

// Values and visible labels stay separate so an id can display and search by a
// human-readable name. The query exists only while the list is open; every
// selection and freeform entry passes through the same normalization.
export function MultiselectCombobox({
  ariaLabel,
  className,
  clearLabel,
  closedLabel = '',
  freeform = false,
  normalizeValue = entry => entry,
  onChange,
  options,
  placeholder,
  readOnly,
  renderOption,
  value,
}: {
  ariaLabel?: string;
  className?: string;
  clearLabel?: string;
  closedLabel?: string;
  freeform?: boolean;
  normalizeValue?: (entry: string) => string;
  onChange: (value: string[]) => void;
  options: readonly MultiselectOption[];
  placeholder: string;
  readOnly?: boolean;
  renderOption?: (option: MultiselectOption) => ReactNode;
  value: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const optionValues = new Set(options.map(option => option.value));
  const completeOptions = [
    ...options,
    ...[...new Set(value)].filter(entry => !optionValues.has(entry)).map(entry => ({ value: entry, label: entry })),
  ];
  const visible = completeOptions.filter(option => option.label.toLowerCase().includes(needle));

  const commit = (next: readonly string[]) => {
    const normalized = [...new Set(next.map(normalizeValue).filter(Boolean))];
    if (!sameValues(normalized, value)) onChange(normalized);
    setQuery('');
  };

  return <Combobox
    aria-label={ariaLabel}
    className={className}
    freeform={freeform}
    multiselect
    onChange={event => setQuery(event.target.value)}
    onKeyDown={freeform ? event => {
      if (event.key !== 'Enter' || query.trim() === '') return;
      event.preventDefault();
      commit([...value, query]);
    } : undefined}
    onOpenChange={(_, data) => { setOpen(data.open); setQuery(''); }}
    onOptionSelect={(_, data) => commit(data.optionValue === '' ? [] : data.selectedOptions)}
    placeholder={placeholder}
    readOnly={readOnly}
    selectedOptions={clearLabel && value.length === 0 ? [''] : [...value]}
    value={open ? query : closedLabel}
  >
    {clearLabel && needle === '' && <Option text={clearLabel} value="">{clearLabel}</Option>}
    {visible.map(option => <Option key={option.value} text={option.label} value={option.value}>
      {renderOption ? renderOption(option) : option.label}
    </Option>)}
  </Combobox>;
}

export const valuesAsOptions = (values: readonly string[]): MultiselectOption[] =>
  values.map(value => ({ value, label: value }));
