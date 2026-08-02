import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { KIND_DEFAULT_TONES, ProviderBadge } from './provider-badge';
import type { UpstreamColor, UpstreamColorPreset, UpstreamProviderKind } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { HEX_RE, hexToRgb, hsvToRgb, isHexColor, rgbToHex, rgbToHsv } from '../../lib/color';
import { useDangerTextClass } from '../ui/danger';
import { Input } from '../ui/fluent-form-controls';
import { UPSTREAM_COLOR_PRESETS } from '@floway-dev/provider/model';

const {
  Button,
  ColorArea,
  ColorPicker,
  ColorSlider,
  ColorSwatch,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  SwatchPicker,
  Text,
} = fluentComponents;

const PRESET_HEX: Record<UpstreamColorPreset, string> = {
  amber: '#ffd740',
  emerald: '#00e676',
  cyan: '#00e5ff',
  violet: '#a78bfa',
  rose: '#ff5252',
  orange: '#ff9800',
};

const DEFAULT_CUSTOM_HEX = '#00e5ff';

export function UpstreamColorPicker({ kind, onChange, onValidityChange, value }: {
  kind: UpstreamProviderKind;
  onChange: (color: UpstreamColor | null) => void;
  onValidityChange: (invalid: boolean) => void;
  value: UpstreamColor | null;
}) {
  const { t } = useTranslation();
  const dangerText = useDangerTextClass();
  const errorId = useId();
  const [hexDraft, setHexDraft] = useState<string>(() => (isHexColor(value) ? value : DEFAULT_CUSTOM_HEX));
  const rgb = hexToRgb(hexDraft) ?? hexToRgb(DEFAULT_CUSTOM_HEX)!;
  const [hue, saturation, brightness] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  const draftInvalid = !HEX_RE.test(hexDraft);
  const visibleLabel = value === null
    ? t('dashboard.upstreamEditor.color.inherit')
    : isHexColor(value)
      ? value
      : t(`dashboard.upstreamEditor.color.preset.${value}`);

  const commitHex = (next: string) => {
    setHexDraft(next);
    const invalid = !HEX_RE.test(next);
    onValidityChange(invalid);
    if (!invalid) onChange(next as UpstreamColor);
  };

  const commitHsv = (nextHue: number, nextSaturation: number, nextValue: number) => {
    const [red, green, blue] = hsvToRgb(nextHue, nextSaturation, nextValue);
    commitHex(rgbToHex(red, green, blue));
  };

  return (
    <div className="grid gap-1.5">
      <Popover positioning={{ position: 'below', align: 'start' }} trapFocus>
        <PopoverTrigger disableButtonEnhancement>
          <Button
            appearance="transparent"
            aria-label={`${t('dashboard.upstreamEditor.color.label')}: ${visibleLabel}`}
            className="!min-w-0 !p-0"
          >
            <ProviderBadge color={value} kind={kind} />
          </Button>
        </PopoverTrigger>
        <PopoverSurface className="w-[min(360px,calc(100vw-32px))]">
          <div className="grid gap-3">
            <SwatchPicker
              aria-label={t('dashboard.upstreamEditor.color.label')}
              layout="row"
              selectedValue={isHexColor(value) ? '' : (value ?? 'inherit')}
              onSelectionChange={(_, data) => {
                onValidityChange(false);
                onChange(data.selectedValue === 'inherit' ? null : (data.selectedValue as UpstreamColorPreset));
              }}
            >
              <ColorSwatch
                aria-label={t('dashboard.upstreamEditor.color.inherit')}
                color={PRESET_HEX[KIND_DEFAULT_TONES[kind]]}
                value="inherit"
                style={{ outline: '2px dashed var(--colorNeutralStroke1)', outlineOffset: '2px' }}
              />
              {UPSTREAM_COLOR_PRESETS.map(preset => (
                <ColorSwatch
                  aria-label={t(`dashboard.upstreamEditor.color.preset.${preset}`)}
                  color={PRESET_HEX[preset]}
                  key={preset}
                  value={preset}
                />
              ))}
            </SwatchPicker>

            <ColorPicker
              color={{ h: hue, s: saturation, v: brightness }}
              onColorChange={(_, data) => commitHsv(data.color.h, data.color.s, data.color.v)}
            >
              <ColorArea inputX={{ 'aria-label': t('dashboard.upstreamEditor.color.saturation') }} inputY={{ 'aria-label': t('dashboard.upstreamEditor.color.brightness') }} />
              <ColorSlider aria-label={t('dashboard.upstreamEditor.color.hue')} />
            </ColorPicker>

            <div className="flex items-center gap-2">
              <Input
                aria-describedby={draftInvalid ? errorId : undefined}
                aria-invalid={draftInvalid || undefined}
                aria-label={t('dashboard.upstreamEditor.color.custom')}
                className="!w-[140px] font-mono"
                maxLength={7}
                value={hexDraft}
                onChange={(_, data) => commitHex(data.value.trim())}
              />
              {draftInvalid
                ? <Text className={dangerText} id={errorId} role="alert" size={200}>{t('dashboard.upstreamEditor.color.invalidHex')}</Text>
                : <ColorSwatch aria-hidden color={hexDraft} value={hexDraft} />}
            </div>
          </div>
        </PopoverSurface>
      </Popover>
    </div>
  );
}
