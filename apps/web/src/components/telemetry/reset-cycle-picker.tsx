import { ChevronLeftRegular, ChevronRightRegular } from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';

import { readResetCycles, resetRangeAt, type ResetCycleHistory, type ResetMetric } from './reset-cycles';
import type { ApiResult } from '../../api/client';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { numericDate, numericTime } from '../../lib/format-time';
import { isResetRange, type DashboardRange, type DashboardResetRange } from '../charts/dashboard-time';
import { Dropdown } from '../ui/fluent-form-controls';
import { PANEL_STACK_CLASS, TIGHT_STACK_CLASS } from '../ui/layout';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { upstreamMetricDisplayName } from '../upstream-metrics/display-name';
import { formatUpstreamMetricIdentity, upstreamMetricIdentityKey } from '@floway-dev/upstream/browser';

const { Button, Field, Option, Spinner, Text } = fluentComponents;

const cycleDateTime = (timestamp: number) => {
  const date = new Date(timestamp);
  return `${numericDate(date, true)} ${numericTime(date)}`;
};

interface PickerProps {
  upstreamId: string;
  range: DashboardRange;
  loadedAt: number;
  onApply: (range: DashboardResetRange) => void;
  onCancel: () => void;
}

export function ResetCyclePicker({ upstreamId, range, loadedAt, onApply, onCancel }: PickerProps) {
  const { t } = useTranslation();
  // Keep browsing against the snapshot at the time the flyout opened.
  const [snapshot] = useState({ range, loadedAt });
  const [result, setResult] = useState<ApiResult<ResetCycleHistory>>();
  useEffect(() => {
    const controller = new AbortController();
    void readResetCycles(upstreamId, snapshot.loadedAt, controller.signal, { view: 'history' }).then(response => {
      if (!controller.signal.aborted) setResult(response);
    });
    return () => controller.abort();
  }, [upstreamId, snapshot]);
  if (result?.data?.supported) return <ResetCycleOptions upstreamId={upstreamId} history={result.data}
    loadedAt={snapshot.loadedAt} range={snapshot.range} onApply={onApply} onCancel={onCancel} />;
  return <div className={PANEL_STACK_CLASS}>
    {result === undefined ? <Spinner size="small" label={t('common.loading')} />
      : <Text role="alert">{result.error?.message ?? t('common.errors.viewUnavailable')}</Text>}
    <Button onClick={onCancel}>{t('common.cancel')}</Button>
  </div>;
}

type CyclePage = ResetMetric & { hasNewer?: boolean };

function ResetCycleOptions({ upstreamId, history, range, loadedAt, onApply, onCancel }: PickerProps & { history: ResetCycleHistory }) {
  const { t } = useTranslation();
  const [pages, setPages] = useState(() => {
    const pages = new Map<string, CyclePage>(history.metrics.map(metric => [upstreamMetricIdentityKey(metric.identity), metric]));
    if (isResetRange(range) && range.upstreamId === upstreamId && range.end !== null) {
      const key = upstreamMetricIdentityKey(range.metric);
      const metric = pages.get(key);
      if (metric !== undefined && !metric.starts.includes(range.start)) {
        pages.set(key, { ...metric, starts: [range.end, range.start], hasMore: true, hasNewer: metric.starts[0] !== range.end });
      }
    }
    return pages;
  });
  const metrics = [...pages].map(([key, metric]) => ({ ...metric, key, label: upstreamMetricDisplayName(metric.display, t) }));
  const [selection, setSelection] = useState(() => {
    const applied = isResetRange(range) ? metrics.find(metric => metric.key === upstreamMetricIdentityKey(range.metric)) : undefined;
    const metric = applied ?? metrics.find(metric => metric.starts.length > 0) ?? metrics.at(0);
    return { key: metric?.key, offset: applied && isResetRange(range) ? Math.max(0, applied.starts.indexOf(range.start)) : 0 };
  });
  const metric = metrics.find(metric => metric.key === selection.key);
  const { offset } = selection;
  const cycle = metric === undefined ? null : resetRangeAt(upstreamId, metric, offset);
  const controllerRef = useRef<AbortController | null>(null);
  const [paging, setPaging] = useState(false);
  const [pageError, setPageError] = useState<string>();
  useEffect(() => () => controllerRef.current?.abort(), []);

  const move = async (direction: 1 | -1) => {
    if (metric === undefined || controllerRef.current !== null) return;
    setPageError(undefined);
    const index = offset + direction;
    const older = direction === 1;
    const needsPage = older ? index === metric.starts.length && metric.hasMore : index === 0 && metric.hasNewer;
    if (!needsPage) {
      if (index >= 0 && index < metric.starts.length) setSelection({ key: metric.key, offset: index });
      return;
    }
    const boundary = older ? metric.starts.at(-1) : metric.starts[0];
    if (boundary === undefined) throw new Error('Reset cycle page has no boundary');
    const controller = new AbortController();
    controllerRef.current = controller;
    setPaging(true);
    try {
      const result = await readResetCycles(upstreamId, older ? boundary : loadedAt, controller.signal,
        { view: 'history', metric: metric.identity, ...(older ? {} : { after: boundary }) });
      if (controller.signal.aborted) return;
      const page = result.data?.metrics[0];
      if (result.error || !result.data.supported || page === undefined) {
        setPageError(result.error?.message ?? t('common.errors.viewUnavailable'));
        return;
      }
      const { hasMore, hasNewer, ...previous } = pages.get(metric.key)!;
      setPages(new Map(pages).set(metric.key, older
        ? { ...previous, starts: [...metric.starts, ...page.starts], ...(page.hasMore && { hasMore: true }), ...(hasNewer && { hasNewer }) }
        : { ...previous, starts: [...page.starts, ...metric.starts], ...(hasMore && { hasMore }), hasNewer: page.hasMore === true }));
      setSelection({ key: metric.key, offset: older ? (page.starts.length > 0 ? index : offset) : page.starts.length });
    } finally {
      controllerRef.current = null;
      if (!controller.signal.aborted) setPaging(false);
    }
  };
  const labelFor = (candidate: typeof metrics[number]) => metrics.some(other => other.key !== candidate.key && other.label === candidate.label)
    ? formatUpstreamMetricIdentity(candidate.identity) : candidate.label;
  const dates = <Text align="center" aria-live="polite" className="text-fui-fg2" size={200}>
    {cycle === null ? t('monitoring.controls.resetCycle.waiting') : <>
      <span className="inline-block">{cycleDateTime(cycle.start)}</span>{' - '}
      <span className="inline-block">{cycleDateTime(cycle.end ?? loadedAt)}</span>
    </>}
  </Text>;

  return <div className={PANEL_STACK_CLASS}>
    {metric && <Field label={t('monitoring.controls.resetCycle.window')}>
      <Dropdown button={{ autoFocus: true }} className="w-full" disabled={paging} selectedOptions={[metric.key]} value={labelFor(metric)}
        onOptionSelect={(_, { optionValue }) => {
          if (optionValue === undefined || optionValue === selection.key) return;
          setPageError(undefined);
          setSelection({ key: optionValue, offset: pages.get(optionValue)?.hasNewer ? 1 : 0 });
        }}>
        {metrics.map(option => <Option key={option.key} value={option.key}>{labelFor(option)}</Option>)}
      </Dropdown>
    </Field>}
    {metric ? <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
      <TooltipIconButton disabledFocusable={paging || (offset + 1 >= metric.starts.length && !metric.hasMore)} icon={<ChevronLeftRegular />}
        label={t('monitoring.controls.resetCycle.older')} onClick={() => { void move(1); }} />
      <div className={TIGHT_STACK_CLASS}>
        <Text align="center" role="status" weight="semibold">
          {metric.hasNewer ? t('monitoring.controls.resetCycle.historical')
            : offset === 0 ? t('monitoring.controls.resetCycle.current')
              : offset === 1 ? t('monitoring.controls.resetCycle.previous')
                : t('monitoring.controls.resetCycle.ago', { count: offset })}
        </Text>
        {dates}
      </div>
      <TooltipIconButton disabledFocusable={paging || offset === 0} icon={<ChevronRightRegular />}
        label={t('monitoring.controls.resetCycle.newer')} onClick={() => { void move(-1); }} />
    </div> : dates}
    {pageError !== undefined && <Text role="alert">{pageError}</Text>}
    <div className="flex flex-wrap justify-end gap-2">
      <Button onClick={onCancel}>{t('common.cancel')}</Button>
      <Button appearance="primary" disabled={paging || cycle === null} onClick={() => { if (cycle !== null) onApply(cycle); }}>
        {t('monitoring.controls.resetCycle.apply')}
      </Button>
    </div>
  </div>;
}
