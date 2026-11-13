import { useState } from 'react';

import { resetCycleRange, type UpstreamResetCycles } from './reset-cycles';
import { TelemetryTimeRange, type ResetCyclePickerControls } from './time-range';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { isResetRange, type DashboardRange, type DashboardResetRange } from '../charts/dashboard-time';
import { Dropdown } from '../ui/fluent-form-controls';
import { PANEL_STACK_CLASS } from '../ui/layout';
import { ScrollArea } from '../ui/scroll-area';
import { upstreamMetricDisplayName } from '../upstream-metrics/display-name';
import { formatUpstreamMetricIdentity, upstreamMetricIdentityKey } from '@floway-dev/provider/browser';

const { Button, Field, Option } = fluentComponents;
type ResetSelection = { upstreamId: string; metric: string; cycle: DashboardResetRange['cycle'] };

export function TelemetryRangeControls({ disabled = false, resetCycles, ...props }: Omit<Parameters<typeof TelemetryTimeRange>[0], 'resetCyclePicker'> & { disabled?: boolean; resetCycles: UpstreamResetCycles | null }) {
  const [selected, setSelected] = useState<ResetSelection | null>(null);
  return <div className="ml-auto min-w-0 max-w-full" inert={disabled}>
    <ScrollArea axes="horizontal" className="floway-telemetry-range-scroller" contentClassName="floway-telemetry-range-scroll-content">
      <TelemetryTimeRange {...props} resetCyclePicker={resetCycles?.metrics.length ? {
        component: ResetCyclePicker,
        props: {
          disabled, initialRange: props.range, loadedAt: props.loadedAt, previous: selected, resetCycles,
          onSelect: (range: DashboardResetRange) => setSelected({ upstreamId: range.upstreamId, metric: upstreamMetricIdentityKey(range.metric), cycle: range.cycle }),
        },
      } : undefined} />
    </ScrollArea>
  </div>;
}

function ResetCyclePicker({ disabled, initialRange, loadedAt, onApply, onCancel, onSelect, previous, resetCycles }: {
  disabled: boolean;
  initialRange: DashboardRange;
  loadedAt: number;
  onSelect: (range: DashboardResetRange) => void;
  previous: ResetSelection | null;
  resetCycles: UpstreamResetCycles;
} & ResetCyclePickerControls) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState(() => {
    const saved = isResetRange(initialRange) && initialRange.upstreamId === resetCycles.upstreamId
      ? { metric: upstreamMetricIdentityKey(initialRange.metric), cycle: initialRange.cycle }
      : previous?.upstreamId === resetCycles.upstreamId ? previous : null;
    const metric = resetCycles.metrics.find(metric => upstreamMetricIdentityKey(metric.identity) === saved?.metric)
      ?? resetCycles.metrics.find(metric => resetCycleRange(resetCycles, metric, 'current', loadedAt) !== null)
      ?? resetCycles.metrics[0];
    if (metric === undefined) throw new TypeError('Reset cycle selection requires an observed reset metric');
    return { metric: upstreamMetricIdentityKey(metric.identity), cycle: saved?.cycle ?? 'current' };
  });
  const metric = resetCycles.metrics.find(metric => upstreamMetricIdentityKey(metric.identity) === selection.metric);
  if (metric === undefined) throw new TypeError('The selected reset metric is no longer available');
  const current = resetCycleRange(resetCycles, metric, 'current', loadedAt);
  const previousRange = resetCycleRange(resetCycles, metric, 'previous', loadedAt);
  const next = selection.cycle === 'current' ? current : previousRange;
  const names = resetCycles.metrics.map(metric => upstreamMetricDisplayName(metric.display, t));
  const metricName = (metric: UpstreamResetCycles['metrics'][number]) => {
    const name = upstreamMetricDisplayName(metric.display, t);
    return names.filter(candidate => candidate === name).length > 1 ? formatUpstreamMetricIdentity(metric.identity) : name;
  };
  return <div className={PANEL_STACK_CLASS}>
    <Field label={t('dashboard.telemetry.resetMetric.label')} hint={t(current === null ? 'dashboard.telemetry.resetMetric.waiting'
      : previousRange === null ? 'dashboard.telemetry.resetCycle.previousWaiting' : 'dashboard.telemetry.resetMetric.hint')}>
      <Dropdown aria-label={t('dashboard.telemetry.resetMetric.label')} button={{ autoFocus: true }} className="w-full" disabled={disabled} selectedOptions={[selection.metric]}
        value={metricName(metric)} onOptionSelect={(_, data) => {
          const next = resetCycles.metrics.find(metric => upstreamMetricIdentityKey(metric.identity) === data.optionValue);
          if (next === undefined) return;
          setSelection(selected => ({
            metric: upstreamMetricIdentityKey(next.identity),
            cycle: resetCycleRange(resetCycles, next, selected.cycle, loadedAt) === null ? 'current' : selected.cycle,
          }));
        }}>
        {resetCycles.metrics.map(metric => <Option key={upstreamMetricIdentityKey(metric.identity)} value={upstreamMetricIdentityKey(metric.identity)}>{metricName(metric)}</Option>)}
      </Dropdown>
    </Field>
    <Field label={t('dashboard.telemetry.resetCycle.label')}>
      <Dropdown aria-label={t('dashboard.telemetry.resetCycle.label')} className="w-full" disabled={disabled} selectedOptions={[selection.cycle]}
        value={t(selection.cycle === 'current' ? 'dashboard.telemetry.range.currentReset' : 'dashboard.telemetry.range.previousReset')}
        onOptionSelect={(_, data) => {
          const cycle = data.optionValue;
          if (cycle === 'current' || cycle === 'previous') setSelection(selected => ({ ...selected, cycle }));
        }}>
        <Option disabled={current === null} value="current">{t('dashboard.telemetry.range.currentReset')}</Option>
        <Option disabled={previousRange === null} value="previous">{t('dashboard.telemetry.range.previousReset')}</Option>
      </Dropdown>
    </Field>
    <div className="flex justify-end gap-2">
      <Button disabled={disabled} onClick={onCancel}>{t('common.cancel')}</Button>
      <Button appearance="primary" disabled={disabled || next === null} onClick={() => { if (next !== null) { onSelect(next); onApply(next); } }}>{t('dashboard.telemetry.resetCycle.view')}</Button>
    </div>
  </div>;
}
