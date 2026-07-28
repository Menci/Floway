import { fluentComponents } from '../../fluent';

const { Radio, RadioGroup } = fluentComponents;

export interface ChoiceGroupItem {
  value: string;
  label: string;
  disabled?: boolean;
}

export function ChoiceGroup({
  ariaLabel,
  items,
  onChange,
  value,
}: {
  ariaLabel: string;
  items: ChoiceGroupItem[];
  onChange: (value: string) => void;
  value: string;
}) {
  return <RadioGroup
    aria-label={ariaLabel}
    className="!flex !flex-wrap !gap-x-3"
    layout="horizontal"
    onChange={(_, data) => onChange(data.value)}
    value={value}
  >
    {items.map(item => <Radio disabled={item.disabled} key={item.value} label={item.label} value={item.value} />)}
  </RadioGroup>;
}
