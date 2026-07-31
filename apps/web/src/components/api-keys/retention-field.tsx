import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { fluentComponents } from '../../fluent';
import { formatDurationInput, parseDuration } from '../../lib/duration-input';
import { useDangerTextClass } from '../ui/danger';
import { Combobox, LISTBOX_POSITIONING } from '../ui/fluent-form-controls';
import { SettingsCard, SettingsExpander } from '../ui/settings-card';

const { Option, Text } = fluentComponents;

const SECONDS_PER_DAY = 24 * 60 * 60;

// `null` and `0` both mean "off" depending on the field; the gateway
// distinguishes them, so the caller says which one this control emits.
export type RetentionValue = number | null | 'invalid';

// The sentinel is a state of the editor, not a value the gateway has a name
// for, so it is dropped at the point a form turns its draft into a request. A
// form that submits one has already been let through by a rule that should
// have refused it, and says so rather than inventing a period.
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

// A settings row whose trailing control is the period itself, so the row needs
// no label of its own -- the header already names what is being retained.
//
// The list holds off and the presets, and a period outside them is typed into
// the same control rather than into a second field beside it. That is what a
// freeform combobox is for, and it also keeps the control inside the 240 a
// settings row gives its action, where a two-column pair of fields had to take
// half the dialog.
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

  // The sentinel the control emits is the whole of the rule: re-parsing the
  // draft here would state the same condition a second time and let the two
  // disagree.
  const invalid = value === 'invalid';
  const displayValue = choice === 'off'
    ? offLabel
    : choice === 'custom'
      ? custom
      : presets.find(preset => `seconds:${preset.seconds}` === choice)!.label;

  const action = <Combobox
    aria-label={label}
    className="!w-auto flex-none"
    disabled={disabled}
    freeform
    // The row's action is as wide as what it currently reads, not as wide
    // as its widest option -- a settings row sizes its control to its
    // value. An input has no intrinsic content width, so the character
    // count is what states it, and the list is free to be wider: it hangs
    // off the trailing edge and grows the other way.
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

  // A period on its own is a plain row. What a row opens to reveal is whatever
  // else the period brought with it -- for the captured requests, the way to go
  // and read them -- so the row grows a disclosure exactly when there is
  // something behind it.
  return <>
    {children === undefined
      ? <SettingsCard action={action} description={description} header={label} icon={icon} />
      : <SettingsExpander action={action} description={description} expandLabel={label} header={label} icon={icon}>{children}</SettingsExpander>}
    {invalid && <Text className={dangerText} role="alert" size={200}>{t('dashboard.apiKeys.retention.invalid')}</Text>}
  </>;
}
