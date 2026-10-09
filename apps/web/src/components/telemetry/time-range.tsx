import { useCallback, useEffect, useRef, useState } from 'react';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import {
  dashboardInterval,
  dashboardRangeFromInterval,
  type DashboardRange,
} from '../charts/dashboard-time';
import { ChoiceGroup } from '../ui/choice-group';
import { DateTimePicker } from '../ui/date-time-picker';
import { TELEMETRY_HOUR_MS } from '@floway-dev/protocols/common';

const { Text, makeStyles, tokens } = fluentComponents;
const useStyles = makeStyles({
  root: { display: 'grid', justifyItems: 'end', rowGap: tokens.spacingVerticalXS, minWidth: '0' },
  editor: {
    textAlign: 'end',
    fontSize: tokens.fontSizeBase200, lineHeight: tokens.lineHeightBase300,
    color: 'var(--winui-text-fill-secondary)',
  },
  error: { color: tokens.colorPaletteRedForeground1, maxWidth: '100%' },
});

type Interval = { start: number; end: number };

export function TelemetryTimeRange({
  addressOf, ariaLabel, loadedAt, onChange, onEditingChange, range,
}: {
  addressOf: (range: DashboardRange) => string;
  ariaLabel: string;
  loadedAt: number;
  onChange: (range: DashboardRange) => void;
  onEditingChange: (editing: boolean) => void;
  range: DashboardRange;
}) {
  const { t } = useTranslation();
  const styles = useStyles();
  const applied = dashboardInterval(range, loadedAt);
  const [draft, setDraft] = useState<Interval>(applied);
  const [editing, setEditing] = useState(false);
  const [invalidInterval, setInvalidInterval] = useState(false);
  const [openEndpoint, setOpenEndpoint] = useState<'start' | 'end' | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const surfaces = useRef(new Map<string, HTMLElement>());
  const draftRef = useRef(draft);
  const originalRef = useRef(applied);
  const editingRef = useRef(false);

  const owns = useCallback((target: EventTarget | null) => target instanceof Node && (
    groupRef.current?.contains(target) === true || [...surfaces.current.values()].some(element => element.contains(target))
  ), []);
  const begin = () => {
    if (editingRef.current) return;
    editingRef.current = true;
    originalRef.current = applied;
    if (!invalidInterval) {
      draftRef.current = applied;
      setDraft(applied);
    }
    setEditing(true);
    onEditingChange(true);
  };
  const finish = useCallback(() => {
    if (!editingRef.current) return;
    editingRef.current = false;
    setEditing(false);
    onEditingChange(false);
    setOpenEndpoint(null);
    const interval = draftRef.current;
    if (interval.start >= interval.end) {
      setInvalidInterval(true);
      return;
    }
    setInvalidInterval(false);
    if (interval.start !== originalRef.current.start || interval.end !== originalRef.current.end) {
      onChange(dashboardRangeFromInterval(interval.start, interval.end, Date.now()));
    } else if (typeof range === 'string') {
      const current = dashboardInterval(range, Date.now());
      if (current.start !== originalRef.current.start || current.end !== originalRef.current.end) onChange(range);
    }
  }, [onChange, onEditingChange, range]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!owns(event.target) && editingRef.current) queueMicrotask(finish);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [finish, owns]);

  const cancel = () => {
    editingRef.current = false;
    setEditing(false);
    onEditingChange(false);
    setInvalidInterval(false);
    setOpenEndpoint(null);
    draftRef.current = applied;
    setDraft(applied);
  };
  const selectPreset = (next: DashboardRange) => {
    cancel();
    onChange(next);
  };
  const changeEndpoint = (endpoint: 'start' | 'end', value: number) => {
    const next = { ...draftRef.current, [endpoint]: value };
    draftRef.current = next;
    setDraft(next);
  };
  const handleStartChange = (value: number) => changeEndpoint('start', value);
  const handleEndChange = (value: number) => changeEndpoint('end', value);
  const registerSurface = useCallback((key: string, element: HTMLDivElement | null) => {
    if (element === null) surfaces.current.delete(key);
    else surfaces.current.set(key, element);
  }, []);
  const startSurfaceRef = useCallback((element: HTMLDivElement | null) => registerSurface('start', element), [registerSurface]);
  const endSurfaceRef = useCallback((element: HTMLDivElement | null) => registerSurface('end', element), [registerSurface]);
  const startTimeSurfaceRef = useCallback((element: HTMLDivElement | null) => registerSurface('start-time', element), [registerSurface]);
  const endTimeSurfaceRef = useCallback((element: HTMLDivElement | null) => registerSurface('end-time', element), [registerSurface]);
  const shown = editing || invalidInterval ? draft : applied;

  return <div className={styles.root}>
    <div onPointerDownCapture={event => {
      if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) cancel();
    }}>
      <ChoiceGroup ariaLabel={ariaLabel} items={[
        { value: 'today', label: t('dashboard.telemetry.range.oneDay'), to: addressOf('today') },
        { value: '7d', label: t('dashboard.telemetry.range.sevenDays'), to: addressOf('7d') },
        { value: '30d', label: t('dashboard.telemetry.range.thirtyDays'), to: addressOf('30d') },
      ]} onChange={value => selectPreset(value as DashboardRange)} value={typeof range === 'string' ? range : ''} />
    </div>
    <div
      className={styles.editor}
      onBlurCapture={event => {
        if (owns(event.relatedTarget)) return;
        queueMicrotask(() => {
          if (document.hasFocus() && !owns(document.activeElement)) finish();
        });
      }}
      onKeyDown={event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }}
      ref={groupRef}
    >
      <DateTimePicker
        label={t('dashboard.telemetry.range.start')}
        timeSurfaceRef={startTimeSurfaceRef}
        onChange={handleStartChange}
        onOpenChange={open => { if (open) begin(); setOpenEndpoint(current => open ? 'start' : current === 'start' ? null : current); }}
        open={openEndpoint === 'start'}
        stepMs={TELEMETRY_HOUR_MS}
        surfaceRef={startSurfaceRef}
        value={shown.start}
      />
      {' '}{t('dashboard.telemetry.range.to')}{' '}
      <DateTimePicker
        label={t('dashboard.telemetry.range.end')}
        timeSurfaceRef={endTimeSurfaceRef}
        onChange={handleEndChange}
        onOpenChange={open => { if (open) begin(); setOpenEndpoint(current => open ? 'end' : current === 'end' ? null : current); }}
        open={openEndpoint === 'end'}
        stepMs={TELEMETRY_HOUR_MS}
        surfaceRef={endSurfaceRef}
        value={shown.end}
      />
    </div>
    {invalidInterval && <Text className={styles.error} role="alert" size={200}>{t('dashboard.telemetry.range.invalid')}</Text>}
  </div>;
}
