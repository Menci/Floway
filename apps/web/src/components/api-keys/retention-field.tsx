import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { fluentComponents } from '../../fluent';
import { parseDuration } from '../../lib/parse-duration';
import { Input, Select } from '../ui/fluent-form-controls';

const { Field, Text } = fluentComponents;

const SECONDS_PER_DAY = 24 * 60 * 60;

// `null` and `0` both mean "off" depending on the field; the gateway
// distinguishes them, so the caller says which one this control emits.
export type RetentionValue = number | null | 'invalid';

export interface RetentionPreset {
  readonly seconds: number;
  readonly label: string;
}

type Choice = 'off' | 'custom' | `seconds:${number}`;

const formatDuration = (seconds: number): string => {
  if (seconds % SECONDS_PER_DAY === 0) return `${seconds / SECONDS_PER_DAY}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
};

const choiceFor = (value: RetentionValue, offValue: 0 | null, presets: readonly RetentionPreset[]): Choice => {
  if (value === 'invalid') return 'custom';
  if (value === offValue) return 'off';
  if (value === null) throw new TypeError('Retention field received null for a zero-off field');
  return presets.some(preset => preset.seconds === value) ? `seconds:${value}` : 'custom';
};

export const RetentionField = ({
  children,
  customInputUnit = 'duration',
  description,
  label,
  maximumSeconds,
  minimumSeconds = 1,
  offLabel,
  offValue,
  onChange,
  presets,
  value,
}: {
  children?: React.ReactNode;
  customInputUnit?: 'duration' | 'days';
  description: string;
  label: string;
  maximumSeconds?: number;
  minimumSeconds?: number;
  offLabel: string;
  offValue: 0 | null;
  onChange: (value: RetentionValue) => void;
  presets: readonly RetentionPreset[];
  value: RetentionValue;
}) => {
  const { t } = useTranslation();
  const fieldId = useId();
  const [choice, setChoice] = useState<Choice>(() => choiceFor(value, offValue, presets));
  const [custom, setCustom] = useState(() => (
    typeof value === 'number' && value !== offValue && !presets.some(preset => preset.seconds === value)
      ? (customInputUnit === 'days' ? String(value / SECONDS_PER_DAY) : formatDuration(value))
      : ''
  ));

  const parseCustom = (input: string): number | null => {
    const seconds = customInputUnit === 'duration'
      ? parseDuration(input)
      : /^\d+$/.test(input.trim()) ? Number(input.trim()) * SECONDS_PER_DAY : null;
    if (seconds === null || !Number.isSafeInteger(seconds)) return null;
    if (seconds < minimumSeconds) return null;
    if (maximumSeconds !== undefined && seconds > maximumSeconds) return null;
    return seconds;
  };

  const selectChoice = (next: Choice) => {
    setChoice(next);
    if (next === 'off') {
      setCustom('');
      onChange(offValue);
      return;
    }
    if (next === 'custom') {
      onChange(parseCustom(custom) ?? 'invalid');
      return;
    }
    onChange(Number(next.slice('seconds:'.length)));
  };

  const invalid = choice === 'custom' && parseCustom(custom) === null;

  return <div className="grid gap-2">
    <Field
      hint={description}
      label={label}
      validationMessage={invalid ? t('dashboard.apiKeys.retention.invalid') : undefined}
      validationState={invalid ? 'error' : 'none'}
    >
      <div className="grid gap-2 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-[560px]:grid-cols-1">
        <Select id={`${fieldId}-preset`} value={choice} onChange={(_, data) => selectChoice(data.value as Choice)}>
          <option value="off">{offLabel}</option>
          {presets.map(preset => <option key={preset.seconds} value={`seconds:${preset.seconds}`}>{preset.label}</option>)}
          <option value="custom">{t('dashboard.apiKeys.retention.custom')}</option>
        </Select>
        {choice === 'custom' && <Input
          aria-label={t('dashboard.apiKeys.retention.customValue')}
          id={`${fieldId}-custom`}
          placeholder={customInputUnit === 'days' ? t('dashboard.apiKeys.retention.daysPlaceholder') : t('dashboard.apiKeys.retention.durationPlaceholder')}
          value={custom}
          onChange={(_, data) => {
            setCustom(data.value);
            onChange(parseCustom(data.value) ?? 'invalid');
          }}
        />}
      </div>
    </Field>
    {children !== undefined && <div className="grid gap-1">{children}</div>}
    {!invalid && typeof value === 'number' && value !== offValue && <Text size={200} className="text-fui-fg3">
      {t('dashboard.apiKeys.retention.effective', { duration: formatDuration(value) })}
    </Text>}
  </div>;
};
