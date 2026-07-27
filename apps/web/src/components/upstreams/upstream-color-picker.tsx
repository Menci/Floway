import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { KIND_DEFAULT_TONES } from './upstream-paint';
import type { UpstreamColor, UpstreamColorPreset, UpstreamProviderKind } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { HEX_RE, hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from '../../utils/color';
import { Input } from '../ui/fluent-form-controls';
import { UPSTREAM_COLOR_PRESETS } from '@floway-dev/provider/model';

const {
  ColorArea,
  ColorPicker,
  ColorSlider,
  ColorSwatch,
  SwatchPicker,
  Switch,
  Text,
} = fluentComponents;

// Preset swatch fills. These are literal hex rather than `fui-*` tokens
// because the swatch shows the tone itself, not a themed surface — the same
// six tones must read the same in both themes.
const PRESET_HEX: Record<UpstreamColorPreset, string> = {
  amber: '#ffd740',
  emerald: '#00e676',
  cyan: '#00e5ff',
  violet: '#a78bfa',
  rose: '#ff5252',
  orange: '#ff9800',
};

const DEFAULT_CUSTOM_HEX = '#00e5ff';

const isHex = (value: UpstreamColor | null): value is `#${string}` => value?.startsWith('#') ?? false;

// Emits null to clear the override, a preset key, or a validated #RRGGBB.
export const UpstreamColorPicker = ({ kind, onChange, onValidityChange, value }: {
  kind: UpstreamProviderKind;
  onChange: (color: UpstreamColor | null) => void;
  onValidityChange?: (invalid: boolean) => void;
  value: UpstreamColor | null;
}) => {
  const { t } = useTranslation();
  const [custom, setCustom] = useState(() => isHex(value));
  const [hexDraft, setHexDraft] = useState<string>(() => (isHex(value) ? value : DEFAULT_CUSTOM_HEX));

  const rgb = hexToRgb(hexDraft) ?? hexToRgb(DEFAULT_CUSTOM_HEX)!;
  const [hue, saturation, brightness] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  const draftInvalid = !HEX_RE.test(hexDraft);

  const commitHex = (next: string) => {
    setHexDraft(next);
    const invalid = !HEX_RE.test(next);
    onValidityChange?.(invalid);
    if (!invalid) onChange(next as UpstreamColor);
  };

  const commitHsv = (nextHue: number, nextSaturation: number, nextValue: number) => {
    const [red, green, blue] = hsvToRgb(nextHue, nextSaturation, nextValue);
    commitHex(rgbToHex(red, green, blue));
  };

  return <div className="grid gap-3">
    <SwatchPicker
      aria-label={t('dashboard.upstreamEditor.color.label')}
      layout="row"
      selectedValue={custom ? '' : (value ?? 'inherit')}
      // ColorSwatch values are strings; 'inherit' stands for the null override.
      onSelectionChange={(_, data) => {
        setCustom(false);
        onValidityChange?.(false);
        onChange(data.selectedValue === 'inherit' ? null : (data.selectedValue as UpstreamColorPreset));
      }}
    >
      <ColorSwatch
        aria-label={t('dashboard.upstreamEditor.color.inherit')}
        color={PRESET_HEX[KIND_DEFAULT_TONES[kind]]}
        value="inherit"
        // A dashed ring says "no override, showing the kind default" rather
        // than looking like a seventh preset.
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

    <Switch
      checked={custom}
      label={t('dashboard.upstreamEditor.color.custom')}
      onChange={(_, data) => {
        setCustom(data.checked);
        if (data.checked) commitHex(hexDraft);
        else {
          onValidityChange?.(false);
          onChange(null);
        }
      }}
    />

    {custom && <div className="grid gap-3">
      <ColorPicker
        color={{ h: hue, s: saturation, v: brightness }}
        onColorChange={(_, data) => commitHsv(data.color.h, data.color.s, data.color.v)}
      >
        <ColorArea inputX={{ 'aria-label': t('dashboard.upstreamEditor.color.saturation') }} inputY={{ 'aria-label': t('dashboard.upstreamEditor.color.brightness') }} />
        <ColorSlider aria-label={t('dashboard.upstreamEditor.color.hue')} />
      </ColorPicker>

      <div className="flex items-center gap-2">
        <Input
          className="!w-[140px] font-mono"
          maxLength={7}
          value={hexDraft}
          onChange={(_, data) => commitHex(data.value.trim())}
        />
        {draftInvalid
          ? <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.color.invalidHex')}</Text>
          : <ColorSwatch aria-hidden color={hexDraft} value={hexDraft} />}
      </div>
    </div>}
  </div>;
};
