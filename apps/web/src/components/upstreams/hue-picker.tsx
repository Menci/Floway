import { useTranslation } from 'react-i18next';

import { ProviderBadge } from './provider-badge';
import { fluentComponents } from '../../fluent';
import { HUE_RAMP_GRADIENT } from '../../lib/hue';
import type { UpstreamProviderKind } from '@floway-dev/provider/model';

const { Button, ColorSlider, Popover, PopoverSurface, PopoverTrigger } = fluentComponents;

export function HuePicker({ hue, kind, onChange }: {
  hue: number;
  kind: UpstreamProviderKind;
  onChange: (hue: number) => void;
}) {
  const { t } = useTranslation();

  return (
    <Popover positioning={{ position: 'below', align: 'start' }} trapFocus>
      <PopoverTrigger disableButtonEnhancement>
        <Button
          appearance="transparent"
          aria-label={`${t('dashboard.upstreamEditor.hue.label')}: ${hue}`}
          className="!min-w-0 !p-0"
        >
          <ProviderBadge upstream={{ hue, kind }} />
        </Button>
      </PopoverTrigger>
      <PopoverSurface className="w-[min(360px,calc(100vw-32px))]">
        <ColorSlider
          aria-label={t('dashboard.upstreamEditor.hue.label')}
          channel="hue"
          color={{ h: hue, s: 1, v: 1 }}
          // The rail carries the tone each hue gives a badge instead of
          // Fluent's HSV spectrum, which names a different colour at the same
          // angle. The thumb needs no such treatment: the WinUI layer already
          // fills it with a solid disc rather than the colour under it.
          rail={{ style: { backgroundImage: HUE_RAMP_GRADIENT } }}
          // The rail's own maximum is 360°, which is 0° under another name.
          onChange={(_, data) => onChange(Math.round(data.color.h) % 360)}
        />
      </PopoverSurface>
    </Popover>
  );
}
