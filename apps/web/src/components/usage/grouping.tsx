import { InfoRegular } from '@fluentui/react-icons';

import type { UsageGroupBy } from './types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { TelemetryGroupByField, type TelemetryDimension } from '../telemetry/dimension-controls';
import { CONTROL_ROW_CLASS } from '../ui/layout';

const { Button, Tooltip } = fluentComponents;

export function UsageGrouping({ disabled, dimensions, groupBy, onChange }: {
  disabled: boolean;
  dimensions: readonly TelemetryDimension<UsageGroupBy>[];
  groupBy: UsageGroupBy;
  onChange: (next: UsageGroupBy) => void;
}) {
  const { t } = useTranslation();
  return <TelemetryGroupByField
    disabled={disabled}
    dimensions={dimensions}
    groupBy={groupBy}
    groupByAdornment={groupBy === 'keyId' && <Tooltip content={t('dashboard.usage.apiKeyScopeInfo')} relationship="description">
      <Button appearance="subtle" aria-label={t('dashboard.usage.apiKeyScopeLabel')} className={CONTROL_ROW_CLASS} icon={<InfoRegular />} />
    </Tooltip>}
    groupByLabel={t('dashboard.usage.groupBy.label')}
    onGroupByChange={onChange}
  />;
}
