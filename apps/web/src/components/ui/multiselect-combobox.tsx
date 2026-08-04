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
  left.length === right.length && left.every((entry, index) => entry === right[index]);

// A multiselect field over a set of values, each carrying the label it reads as
// -- an id whose name lives elsewhere shows the name and searches by it. The
// query lives only while the list is open, so a closed field shows its own
// summary rather than what was last typed into it; a freeform field also
// commits the query on Enter, taking it as both value and label. Every route out
// -- picking an option, typing one -- passes through one normalisation, so a
// typed value and a picked one cannot land in different shapes.
export function MultiselectCombobox({
  ariaLabel,
  className,
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
  const visible = options.filter(option => option.label.toLowerCase().includes(needle));

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
    onOptionSelect={(_, data) => commit(data.selectedOptions)}
    placeholder={placeholder}
    readOnly={readOnly}
    selectedOptions={[...value]}
    value={open ? query : closedLabel}
  >
    {visible.map(option => <Option key={option.value} text={option.label} value={option.value}>
      {renderOption ? renderOption(option) : option.label}
    </Option>)}
  </Combobox>;
}

export const valuesAsOptions = (values: readonly string[]): MultiselectOption[] =>
  values.map(value => ({ value, label: value }));
