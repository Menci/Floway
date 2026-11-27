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

export function TelemetryDisplayOptionsMenu({
  onMergeModelVariantsChange,
  showMergeModelVariants,
}: {
  /** Invoked when `mergeModelVariants` toggles so callers grouped by model can clear stale series ids from `hidden`. */
  onMergeModelVariantsChange?: ((next: boolean) => void) | undefined;
  showMergeModelVariants: boolean;
}) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const { foldSmallSeries, mergeModelVariants } = useUserPreferences();

  const checkedValues = useMemo(() => ({
    display: [
      ...(mergeModelVariants ? ['mergeModelVariants'] : []),
      ...(foldSmallSeries ? ['foldSmallSeries'] : []),
    ],
  }), [foldSmallSeries, mergeModelVariants]);

  const label = t('monitoring.charts.displayOptions.label');
  const reportSaveError = (error: string) => toasts.fail(t('monitoring.charts.displayOptions.saveFailed', { error }));

  return (
    <Menu
      checkedValues={checkedValues}
      onCheckedValueChange={(_, data) => {
        if (showMergeModelVariants) {
          const nextMerge = data.checkedItems.includes('mergeModelVariants');
          if (nextMerge !== mergeModelVariants) {
            onMergeModelVariantsChange?.(nextMerge);
            savePreferenceInBackground({ mergeModelVariants: nextMerge }, reportSaveError);
          }
        }
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
          {showMergeModelVariants && (
            <MenuItemCheckbox name="display" value="mergeModelVariants">
              {t('monitoring.charts.displayOptions.mergeModelVariants')}
            </MenuItemCheckbox>
          )}
          <MenuItemCheckbox name="display" value="foldSmallSeries">
            {t('monitoring.charts.displayOptions.foldSmallSeries')}
          </MenuItemCheckbox>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
