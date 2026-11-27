import { OptionsRegular } from '@fluentui/react-icons';
import { useMemo } from 'react';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { savePreferenceInBackground, useUserPreferences } from '../../lib/use-preferences';
import { useOutcomeToasts } from '../ui/outcome-toast';

const {
  Menu,
  MenuItemCheckbox,
  MenuList,
  MenuPopover,
  MenuTrigger,
  ToolbarButton,
  Tooltip,
} = fluentComponents;

export function TelemetryDisplayOptionsMenu() {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const { foldSmallSeries } = useUserPreferences();

  const checkedValues = useMemo(() => ({
    display: foldSmallSeries ? ['foldSmallSeries'] : [],
  }), [foldSmallSeries]);

  const label = t('monitoring.charts.displayOptions.label');
  const reportSaveError = (error: string) => toasts.fail(t('monitoring.charts.displayOptions.saveFailed', { error }));

  return (
    <Menu
      checkedValues={checkedValues}
      onCheckedValueChange={(_, data) => {
        const nextFold = data.checkedItems.includes('foldSmallSeries');
        if (nextFold !== foldSmallSeries) {
          savePreferenceInBackground({ foldSmallSeries: nextFold }, reportSaveError);
        }
      }}
      persistOnItemClick
      positioning={{ position: 'below', align: 'end' }}
    >
      <MenuTrigger disableButtonEnhancement>
        <Tooltip content={label} relationship="label">
          <ToolbarButton aria-label={label} icon={<OptionsRegular />} />
        </Tooltip>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItemCheckbox name="display" value="foldSmallSeries">
            {t('monitoring.charts.displayOptions.foldSmallSeries')}
          </MenuItemCheckbox>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
