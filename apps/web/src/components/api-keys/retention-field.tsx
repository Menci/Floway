import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { formatDurationInput, parseDuration } from './duration-input';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { useDangerTextClass } from '../ui/danger';
import { Combobox, LISTBOX_POSITIONING } from '../ui/fluent-form-controls';
import { SettingsCard, SettingsExpander } from '../ui/settings-card';

const { Option, Text } = fluentComponents;

const SECONDS_PER_DAY = 24 * 60 * 60;

// `null` and `0` both mean "off" depending on the field; the gateway
// distinguishes them, so the caller says which one this control emits.
export type RetentionValue = number | null | 'invalid';

export const parsedRetention = <T extends number | null>(value: T | 'invalid'): T => {
  if (value === 'invalid') throw new TypeError('Unparseable retention reached the request body');
  return value;
};

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
    ? (customInputUnit === 'days' ? String(value / SECONDS_PER_DAY) : formatDurationInput(value))
    : '',
});

// Freeform combobox rather than a list plus a second field, so an off-preset
// period stays inside the 240 a settings row gives its action.
// https://github.com/microsoft/PowerToys/blob/70e0fc22952c79c6e12dce4096f4b0692ded9d90/src/settings-ui/Settings.UI/SettingsXAML/App.xaml#L68
export function RetentionField({
  children,
  customInputUnit = 'duration',
  description,
  disabled = false,
  icon,
  label,
  maximumSeconds,
  minimumSeconds = 1,
  offLabel,
  offValue,
  onChange,
  presets,
  value,
}: {
  children?: ReactNode;
  customInputUnit?: 'duration' | 'days';
  description: string;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  maximumSeconds?: number;
  minimumSeconds?: number;
  offLabel: string;
  offValue: 0 | null;
  onChange: (value: RetentionValue) => void;
  presets: readonly RetentionPreset[];
  value: RetentionValue;
}) {
  const { t } = useTranslation();
  const dangerText = useDangerTextClass();
  const errorId = useId();
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

  const selectChoice = (next: Exclude<Choice, 'custom'>) => {
    if (next === 'off') {
      setEditor({ value: offValue, choice: next, custom: '' });
      onChange(offValue);
      return;
    }
    const seconds = Number(next.slice('seconds:'.length));
    setEditor({ value: seconds, choice: next, custom: '' });
    onChange(seconds);
  };

  const typeCustom = (text: string) => {
    const parsed = parseCustom(text) ?? 'invalid';
    setEditor({ value: parsed, choice: 'custom', custom: text });
    onChange(parsed);
  };

  const invalid = value === 'invalid';
  const displayValue = choice === 'off'
    ? offLabel
    : choice === 'custom'
      ? custom
      : presets.find(preset => `seconds:${preset.seconds}` === choice)!.label;

  const action = <Combobox
    aria-describedby={invalid ? errorId : undefined}
    aria-invalid={invalid || undefined}
    aria-label={label}
    className="!w-auto flex-none"
    disabled={disabled}
    freeform
    // An input has no intrinsic content width, so the character count sizes the
    // row; ../ui/settings-card.tsx puts a floor under it, on either row form.
    input={{ size: displayValue.length + 1 }}
    listWidth="content"
    onChange={event => typeCustom(event.target.value)}
    onOptionSelect={(_, data) => data.optionValue !== undefined && selectChoice(data.optionValue as Exclude<Choice, 'custom'>)}
    placeholder={customInputUnit === 'days' ? t('dashboard.apiKeys.retention.daysPlaceholder') : t('dashboard.apiKeys.retention.durationPlaceholder')}
    positioning={{ ...LISTBOX_POSITIONING, align: 'end' }}
    selectedOptions={choice === 'custom' ? [] : [choice]}
    value={displayValue}
  >
    <Option value="off">{offLabel}</Option>
    {presets.map(preset => <Option key={preset.seconds} value={`seconds:${preset.seconds}`}>{preset.label}</Option>)}
  </Combobox>;

  return <>
    {children === undefined
      ? <SettingsCard action={action} description={description} header={label} icon={icon} />
      : <SettingsExpander action={action} description={description} header={label} icon={icon}>{children}</SettingsExpander>}
    {invalid && <Text className={dangerText} id={errorId} role="alert" size={200}>{t('dashboard.apiKeys.retention.invalid')}</Text>}
  </>;
}
