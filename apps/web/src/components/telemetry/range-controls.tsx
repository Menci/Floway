import { useState } from 'react';

import { resetCycleRange, type UpstreamResetCycles } from './reset-cycles';
import { TelemetryTimeRange } from './time-range';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { isResetRange } from '../charts/dashboard-time';
import { Dropdown } from '../ui/fluent-form-controls';
import { ScrollArea } from '../ui/scroll-area';
import { upstreamMetricDisplayName } from '../upstream-metrics/display-name';
import { formatUpstreamMetricIdentity, upstreamMetricIdentityKey } from '@floway-dev/provider/browser';

const { Field, Option, Tooltip } = fluentComponents;

export function TelemetryRangeControls({ disabled = false, resetCycles, ...props }: Parameters<typeof TelemetryTimeRange>[0] & { disabled?: boolean; resetCycles: UpstreamResetCycles | null }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<{ upstreamId: string; metric: string } | null>(null);
  const { loadedAt, onChange, range } = props;
  const activeKey = isResetRange(range) ? upstreamMetricIdentityKey(range.metric) : selected?.upstreamId === resetCycles?.upstreamId ? selected?.metric : null;
  const metric = resetCycles?.metrics.find(metric => upstreamMetricIdentityKey(metric.identity) === activeKey)
    ?? resetCycles?.metrics.find(metric => resetCycleRange(resetCycles, metric, 'current', loadedAt) !== null)
    ?? resetCycles?.metrics[0];
  const rangeFor = (cycle: 'current' | 'previous') => {
    if (!resetCycles || !metric) return null;
    const candidates = isResetRange(range) ? [metric] : [metric, ...resetCycles.metrics];
    return candidates.map(metric => resetCycleRange(resetCycles, metric, cycle, loadedAt)).find(range => range !== null) ?? null;
  };
  const resetRanges = resetCycles && metric ? {
    current: rangeFor('current'),
    previous: rangeFor('previous'),
  } : undefined;
  const names = resetCycles?.metrics.map(metric => upstreamMetricDisplayName(metric.display, t)) ?? [];
  const metricName = (metric: NonNullable<typeof resetCycles>['metrics'][number]) => {
    const name = upstreamMetricDisplayName(metric.display, t);
    return names.filter(candidate => candidate === name).length > 1 ? formatUpstreamMetricIdentity(metric.identity) : name;
  };
  return <>
    {isResetRange(range) && resetCycles && metric && <Field className="min-w-[150px] flex-[1_1_150px]" label={t('dashboard.telemetry.resetMetric.label')}>
      <Tooltip content={t(resetRanges?.current === null ? 'dashboard.telemetry.resetMetric.waiting' : 'dashboard.telemetry.resetMetric.hint')} relationship="description">
        <Dropdown aria-label={t('dashboard.telemetry.resetMetric.label')} className="w-full" disabled={disabled} selectedOptions={[upstreamMetricIdentityKey(metric.identity)]}
          value={metricName(metric)} onOptionSelect={(_, data) => {
            const next = resetCycles.metrics.find(metric => upstreamMetricIdentityKey(metric.identity) === data.optionValue);
            if (next === undefined) return;
            setSelected({ upstreamId: resetCycles.upstreamId, metric: upstreamMetricIdentityKey(next.identity) });
            if (isResetRange(range)) onChange(resetCycleRange(resetCycles, next, range.cycle, loadedAt) ?? resetCycleRange(resetCycles, next, 'current', loadedAt) ?? 'today');
          }}>
          {resetCycles.metrics.map(metric => <Option key={upstreamMetricIdentityKey(metric.identity)} value={upstreamMetricIdentityKey(metric.identity)}>{metricName(metric)}</Option>)}
        </Dropdown>
      </Tooltip>
    </Field>}
    <div className="ml-auto min-w-0 max-w-full" inert={disabled}><ScrollArea axes="horizontal" className="floway-telemetry-range-scroller" contentClassName="floway-telemetry-range-scroll-content"><TelemetryTimeRange {...props} onChange={next => {
      if (isResetRange(range)) setSelected({ upstreamId: range.upstreamId, metric: upstreamMetricIdentityKey(range.metric) });
      onChange(next);
    }} resetRanges={resetRanges} /></ScrollArea></div>
  </>;
}
