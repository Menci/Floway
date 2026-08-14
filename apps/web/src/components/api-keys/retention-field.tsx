import { useCallback, useId, useState } from 'react';
import type { ReactNode } from 'react';

import { RetentionCombobox, type RetentionComboboxValue, type RetentionPreset } from './retention-combobox';
import { durationPartsForSeconds, type DurationUnit, type FormatDuration, type MaskedRetentionValue } from './retention-mask';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { useDangerTextClass } from '../ui/danger';
import { SettingsCard, SettingsExpander } from '../ui/settings-card';

const { Text } = fluentComponents;

const UNIT_KEYS = {
  s: 'dashboard.apiKeys.retention.units.second',
  m: 'dashboard.apiKeys.retention.units.minute',
  h: 'dashboard.apiKeys.retention.units.hour',
  d: 'dashboard.apiKeys.retention.units.day',
} as const;

// `null` and `0` both mean "off" depending on the field; the gateway
// distinguishes them, so the caller says which one this control emits.
export type RetentionValue = number | null | 'invalid';

export const parsedRetention = <T extends number | null>(value: T | 'invalid'): T => {
  if (value === 'invalid') throw new TypeError('Unparseable retention reached the request body');
  return value;
};

const comboboxValueFor = (value: RetentionValue, offValue: 0 | null): RetentionComboboxValue => {
  if (value === offValue) return 'off';
  if (value === null) throw new TypeError('Retention field received null for a zero-off field');
  return value;
};

// Freeform combobox rather than a list plus a second field, so an off-preset
// period stays inside the 240 a settings row gives its action.
// https://github.com/microsoft/PowerToys/blob/70e0fc22952c79c6e12dce4096f4b0692ded9d90/src/settings-ui/Settings.UI/SettingsXAML/App.xaml#L68
export function RetentionField({
  children,
  defaultUnit = 'h',
  description,
  disabled = false,
  icon,
  label,
  maximumSeconds,
  minimumSeconds = 1,
  multipleOfSeconds = 1,
  offLabel,
  offValue,
  onChange,
  presets,
  value,
}: {
  children?: ReactNode;
  defaultUnit?: DurationUnit;
  description: string;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  maximumSeconds?: number;
  minimumSeconds?: number;
  multipleOfSeconds?: number;
  offLabel: string;
  offValue: 0 | null;
  onChange: (value: RetentionValue) => void;
  presets: readonly RetentionPreset[];
  value: RetentionValue;
}) {
  const { t } = useTranslation();
  const dangerText = useDangerTextClass();
  const errorId = useId();
  const formatDuration = useCallback<FormatDuration>((draft, unit) => {
    const count = /^\d+$/.test(draft) ? Number(draft) : 2;
    return `${draft} ${t(UNIT_KEYS[unit], { count })}`;
  }, [t]);
  const formatSeconds = useCallback((seconds: number) => {
    const { draft, unit } = durationPartsForSeconds(seconds);
    return formatDuration(draft, unit);
  }, [formatDuration]);
  const [retainFocusedExpander, setRetainFocusedExpander] = useState(false);

  const retentionValueFor = (masked: MaskedRetentionValue): RetentionValue => {
    if (masked === 'off') return offValue;
    if (masked === null
      || masked < minimumSeconds
      || masked % multipleOfSeconds !== 0
      || maximumSeconds !== undefined && masked > maximumSeconds) {
      return 'invalid';
    }
    return masked;
  };

  const invalid = value === 'invalid';
  const comboboxValue = comboboxValueFor(value, offValue);
  const action = <RetentionCombobox
    ariaDescribedBy={invalid ? errorId : undefined}
    defaultUnit={defaultUnit}
    disabled={disabled}
    formatDuration={formatDuration}
    formatSeconds={formatSeconds}
    invalid={invalid}
    label={label}
    offLabel={offLabel}
    onBlur={() => {
      if (!invalid) setRetainFocusedExpander(false);
    }}
    onChange={masked => {
      const next = retentionValueFor(masked);
      onChange(next);
      return comboboxValueFor(next, offValue);
    }}
    onFocus={() => setRetainFocusedExpander(children !== undefined)}
    placeholder={t('dashboard.apiKeys.retention.durationPlaceholder')}
    presets={presets}
    value={comboboxValue}
  />;

  return <>
    {children === undefined && !retainFocusedExpander
      ? <SettingsCard action={action} description={description} header={label} icon={icon} />
      : <SettingsExpander action={action} description={description} header={label} icon={icon}>{children ?? null}</SettingsExpander>}
    {invalid && <Text className={dangerText} id={errorId} role="alert" size={200}>{t('dashboard.apiKeys.retention.invalid')}</Text>}
  </>;
}
