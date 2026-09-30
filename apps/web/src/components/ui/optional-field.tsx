import { Dropdown } from './fluent-form-controls';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';

const { Field, Option } = fluentComponents;

export function OptionalBooleanField({ disabled, label, onChange, readOnly, value }: {
  disabled?: boolean;
  label: string;
  onChange: (value: boolean | undefined) => void;
  readOnly: boolean;
  value: boolean | undefined;
}) {
  const { t } = useTranslation();
  const choices = [
    { value: undefined, label: t('common.undeclared') },
    { value: true, label: t('common.yes') },
    { value: false, label: t('common.no') },
  ];
  const selected = choices.findIndex(choice => choice.value === value);
  return <Field className="min-w-0" label={label}>
    <Dropdown disabled={disabled} readOnly={readOnly} selectedOptions={[String(selected)]} value={choices[selected]!.label} onOptionSelect={(_, data) => {
      if (data.optionValue !== undefined) onChange(choices[Number(data.optionValue)]!.value);
    }}>
      {choices.map((choice, index) => <Option key={index} value={String(index)}>{choice.label}</Option>)}
    </Dropdown>
  </Field>;
}

export function OptionalStringField({ choices, disabled, label, nullable = false, onChange, readOnly, value }: {
  choices: readonly string[];
  disabled?: boolean;
  label: string;
  nullable?: boolean;
  onChange: (value: string | null | undefined) => void;
  readOnly: boolean;
  value: string | null | undefined;
}) {
  const { t } = useTranslation();
  const options = [
    { value: undefined as string | null | undefined, label: t('common.undeclared') },
    ...(nullable ? [{ value: null, label: t('common.clientDefault') }] : []),
    ...[...new Set([...choices, ...(typeof value === 'string' ? [value] : [])])].map(item => ({ value: item, label: item })),
  ];
  const selected = options.findIndex(option => option.value === value);
  return <Field className="min-w-0" label={label}>
    <Dropdown disabled={disabled} readOnly={readOnly} selectedOptions={[String(selected)]} value={options[selected]!.label} onOptionSelect={(_, data) => {
      if (data.optionValue !== undefined) onChange(options[Number(data.optionValue)]!.value);
    }}>
      {options.map((option, index) => <Option key={index} value={String(index)}>{option.label}</Option>)}
    </Dropdown>
  </Field>;
}
