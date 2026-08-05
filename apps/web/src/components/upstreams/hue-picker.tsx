import { ProviderBadge } from './provider-badge';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { HUE_RAIL_GRADIENT } from '../../lib/hue';
import type { UpstreamProviderKind } from '@floway-dev/provider/model';

const { Button, ColorSlider, Popover, PopoverSurface, PopoverTrigger, makeStyles } = fluentComponents;

const useStyles = makeStyles({
  // Fluent lays the slider out as an inline grid at a 200px minimum, so left
  // alone it keeps that width whatever it is put in.
  slider: { width: '100%' },
});

export function HuePicker({ hue, kind, onChange }: {
  hue: number;
  kind: UpstreamProviderKind;
  onChange: (hue: number) => void;
}) {
  const { t } = useTranslation();
  const styles = useStyles();

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
          className={styles.slider}
          color={{ h: hue, s: 1, v: 1 }}
          // Fluent's own rail is an HSV spectrum, which names a different
          // colour at the same angle. The thumb needs no such treatment: the
          // WinUI layer already fills it with a solid disc rather than the
          // colour under it.
          rail={{ style: { backgroundImage: HUE_RAIL_GRADIENT } }}
          // The rail's own maximum is 360°, which is 0° under another name.
          onChange={(_, data) => onChange(Math.round(data.color.h) % 360)}
        />
      </PopoverSurface>
    </Popover>
  );
}
