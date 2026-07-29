import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { fluentComponents } from '../../fluent';
import { parseDuration } from '../../lib/parse-duration';
import { Dropdown, Input } from '../ui/fluent-form-controls';

const { Field, Option, Text } = fluentComponents;

const SECONDS_PER_DAY = 24 * 60 * 60;

// `null` and `0` both mean "off" depending on the field; the gateway
// distinguishes them, so the caller says which one this control emits.
export type RetentionValue = number | null | 'invalid';

export interface RetentionPreset {
  readonly seconds: number;
  readonly label: string;
}

type Choice = 'off' | 'custom' | `seconds:${number}`;

interface RetentionEditorState {
  choice: Choice;
  custom: string;
  value: RetentionValue;
}

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

const editorStateFor = (
  value: RetentionValue,
  offValue: 0 | null,
  presets: readonly RetentionPreset[],
  customInputUnit: 'duration' | 'days',
): RetentionEditorState => ({
  value,
  choice: choiceFor(value, offValue, presets),
  custom: typeof value === 'number' && value !== offValue && !presets.some(preset => preset.seconds === value)
    ? (customInputUnit === 'days' ? String(value / SECONDS_PER_DAY) : formatDuration(value))
    : '',
});

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
  const [editor, setEditor] = useState(() => editorStateFor(value, offValue, presets, customInputUnit));
  if (editor.value !== value) {
    setEditor(editorStateFor(value, offValue, presets, customInputUnit));
  }
  const { choice, custom } = editor;

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
    if (next === 'off') {
      setEditor({ value: offValue, choice: next, custom: '' });
      onChange(offValue);
      return;
    }
    if (next === 'custom') {
      const parsed = parseCustom(custom) ?? 'invalid';
      setEditor({ value: parsed, choice: next, custom });
      onChange(parsed);
      return;
    }
    const seconds = Number(next.slice('seconds:'.length));
    setEditor({ value: seconds, choice: next, custom: '' });
    onChange(seconds);
  };

  const invalid = choice === 'custom' && parseCustom(custom) === null;
  const choiceLabel = choice === 'off'
    ? offLabel
    : choice === 'custom'
      ? t('dashboard.apiKeys.retention.custom')
      : presets.find(preset => `seconds:${preset.seconds}` === choice)!.label;

  return <div aria-describedby={`${fieldId}-description`} aria-labelledby={`${fieldId}-label`} className="grid gap-2" role="group">
    <div className="grid gap-1">
      <Text id={`${fieldId}-label`} weight="semibold">{label}</Text>
      <Text id={`${fieldId}-description`} size={200} className="text-fui-fg2">{description}</Text>
    </div>
    <div className="grid gap-2 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-[560px]:grid-cols-1">
      <Field label={t('dashboard.apiKeys.retention.preset')}>
        <Dropdown id={`${fieldId}-preset`} selectedOptions={[choice]} value={choiceLabel} onOptionSelect={(_, data) => data.optionValue !== undefined && selectChoice(data.optionValue as Choice)}>
          <Option value="off">{offLabel}</Option>
          {presets.map(preset => <Option key={preset.seconds} value={`seconds:${preset.seconds}`}>{preset.label}</Option>)}
          <Option value="custom">{t('dashboard.apiKeys.retention.custom')}</Option>
        </Dropdown>
      </Field>
      {choice === 'custom' && <Field
        label={t('dashboard.apiKeys.retention.customValue')}
        validationMessage={invalid ? t('dashboard.apiKeys.retention.invalid') : undefined}
        validationState={invalid ? 'error' : 'none'}
      >
        <Input
          id={`${fieldId}-custom`}
          placeholder={customInputUnit === 'days' ? t('dashboard.apiKeys.retention.daysPlaceholder') : t('dashboard.apiKeys.retention.durationPlaceholder')}
          value={custom}
          onChange={(_, data) => {
            const parsed = parseCustom(data.value) ?? 'invalid';
            setEditor({ value: parsed, choice: 'custom', custom: data.value });
            onChange(parsed);
          }}
        />
      </Field>}
    </div>
    {children !== undefined && <div className="grid gap-1">{children}</div>}
  </div>;
};
