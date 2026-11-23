import { ChevronLeftRegular, ChevronRightRegular } from '@fluentui/react-icons';
import { useState } from 'react';

import { resetRangeAt, type ResetCycleHistory } from './reset-cycles';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { numericDate, numericTime } from '../../lib/format-time';
import { isResetRange, type DashboardRange, type DashboardResetRange } from '../charts/dashboard-time';
import { Dropdown } from '../ui/fluent-form-controls';
import { PANEL_STACK_CLASS, TIGHT_STACK_CLASS } from '../ui/layout';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { upstreamMetricDisplayName } from '../upstream-metrics/display-name';
import { formatUpstreamMetricIdentity, upstreamMetricIdentityKey } from '@floway-dev/provider/browser';

const { Button, Field, Option, Text } = fluentComponents;

const cycleDateTime = (timestamp: number) => {
  const date = new Date(timestamp);
  return `${numericDate(date, true)} ${numericTime(date)}`;
};

export function ResetCyclePicker({ history, range, loadedAt, onApply, onCancel }: {
  history: ResetCycleHistory;
  range: DashboardRange;
  loadedAt: number;
  onApply: (range: DashboardResetRange) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  // A poll already in flight can finish after the flyout opens. Keep its
  // draft on the dates the operator is browsing, not on a moving offset.
  const [snapshot] = useState({ history, loadedAt });
  const metrics = snapshot.history.metrics.map(metric => ({
    ...metric,
    key: upstreamMetricIdentityKey(metric.identity),
    label: upstreamMetricDisplayName(metric.display, t),
  }));
  const [selection, setSelection] = useState(() => {
    const applied = isResetRange(range) ? metrics.find(metric => metric.key === upstreamMetricIdentityKey(range.metric)) : undefined;
    const metric = applied ?? metrics.find(metric => metric.starts.length > 0) ?? metrics.at(0);
    return { key: metric?.key, offset: applied && isResetRange(range) ? Math.max(0, applied.starts.indexOf(range.start)) : 0 };
  });
  const metric = metrics.find(metric => metric.key === selection.key);
  const { offset } = selection;
  const cycle = metric === undefined ? null : resetRangeAt(snapshot.history.upstreamId, metric, offset);
  const move = (direction: 1 | -1) => {
    if (!metric) return;
    setSelection(current => {
      const index = current.offset + direction;
      return index >= 0 && index < metric.starts.length ? { ...current, offset: index } : current;
    });
  };
  const labelFor = (candidate: typeof metrics[number]) => metrics.some(other => other.key !== candidate.key && other.label === candidate.label)
    ? formatUpstreamMetricIdentity(candidate.identity) : candidate.label;
  const dates = <Text align="center" aria-live="polite" className="text-fui-fg2" size={200}>
    {cycle === null ? t('monitoring.controls.resetCycle.waiting') : <>
      <span className="inline-block">{cycleDateTime(cycle.start)}</span>{' - '}
      <span className="inline-block">{cycleDateTime(cycle.end ?? snapshot.loadedAt)}</span>
    </>}
  </Text>;

  return <div className={PANEL_STACK_CLASS}>
    {metric && <Field label={t('monitoring.controls.resetCycle.window')}>
      <Dropdown button={{ autoFocus: true }} className="w-full" selectedOptions={[metric.key]} value={labelFor(metric)}
        onOptionSelect={(_, { optionValue }) => setSelection(current =>
          optionValue === undefined || current.key === optionValue ? current : { key: optionValue, offset: 0 })}>
        {metrics.map(option => <Option key={option.key} value={option.key}>{labelFor(option)}</Option>)}
      </Dropdown>
    </Field>}
    {metric ? <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
      <TooltipIconButton disabledFocusable={offset + 1 >= metric.starts.length} icon={<ChevronLeftRegular />}
        label={t('monitoring.controls.resetCycle.older')} onClick={() => move(1)} />
      <div className={TIGHT_STACK_CLASS}>
        <Text align="center" role="status" weight="semibold">
          {offset === 0 ? t('monitoring.controls.resetCycle.current')
            : offset === 1 ? t('monitoring.controls.resetCycle.previous')
              : t('monitoring.controls.resetCycle.ago', { count: offset })}
        </Text>
        {dates}
      </div>
      <TooltipIconButton disabledFocusable={offset === 0} icon={<ChevronRightRegular />}
        label={t('monitoring.controls.resetCycle.newer')} onClick={() => move(-1)} />
    </div> : dates}
    <div className="flex flex-wrap justify-end gap-2">
      <Button onClick={onCancel}>{t('common.cancel')}</Button>
      <Button appearance="primary" disabled={cycle === null} onClick={() => { if (cycle !== null) onApply(cycle); }}>
        {t('monitoring.controls.resetCycle.apply')}
      </Button>
    </div>
  </div>;
}
