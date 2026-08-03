import { useState } from 'react';
import type { ReactNode } from 'react';

import { Combobox } from './fluent-form-controls';
import { fluentComponents } from '../../fluent';

const { Option } = fluentComponents;

const sameValues = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);

// A multiselect field whose value is a set of short tags. The query lives only
// while the list is open, so a closed field shows its own summary rather than
// what was last typed into it; a freeform field also commits the query on
// Enter. Every route out -- picking an option, typing one -- passes through one
// normalisation, so a typed tag and a picked one cannot land in different
// shapes.
export function TagCombobox({
  ariaLabel,
  closedLabel = '',
  freeform = false,
  normalizeValue = tag => tag,
  onChange,
  options,
  placeholder,
  readOnly,
  renderOption,
  value,
}: {
  ariaLabel?: string;
  closedLabel?: string;
  freeform?: boolean;
  normalizeValue?: (tag: string) => string;
  onChange: (value: string[]) => void;
  options: readonly string[];
  placeholder: string;
  readOnly?: boolean;
  renderOption?: (option: string) => ReactNode;
  value: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const visible = options.filter(option => option.toLowerCase().includes(needle));

  const commit = (next: readonly string[]) => {
    const normalized = [...new Set(next.map(normalizeValue).filter(Boolean))];
    if (!sameValues(normalized, value)) onChange(normalized);
    setQuery('');
  };

  return <Combobox
    aria-label={ariaLabel}
    freeform={freeform}
    multiselect
    onChange={event => setQuery(event.target.value)}
    onKeyDown={freeform ? event => {
      if (event.key !== 'Enter' || query.trim() === '') return;
      event.preventDefault();
      commit([...value, query]);
    } : undefined}
    onOpenChange={(_, data) => { setOpen(data.open); setQuery(''); }}
    onOptionSelect={(_, data) => commit(data.selectedOptions)}
    placeholder={placeholder}
    readOnly={readOnly}
    selectedOptions={[...value]}
    value={open ? query : closedLabel}
  >
    {visible.map(option => <Option key={option} text={option} value={option}>
      {renderOption ? renderOption(option) : option}
    </Option>)}
  </Combobox>;
}
