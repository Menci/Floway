import { useCallback, useEffect, useRef, useState } from 'react';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import {
  dashboardGranularity,
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
    display: 'flex', alignItems: 'center', justifyContent: 'end', flexWrap: 'wrap',
    columnGap: tokens.spacingHorizontalS, rowGap: tokens.spacingVerticalXS,
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
  const [error, setError] = useState<'date' | 'interval' | null>(null);
  const [openEndpoint, setOpenEndpoint] = useState<'start' | 'end' | null>(null);
  const [resetToken, setResetToken] = useState(0);
  const groupRef = useRef<HTMLDivElement>(null);
  const surfaces = useRef(new Map<string, HTMLElement>());
  const draftRef = useRef(draft);
  const originalRef = useRef(applied);
  const validRef = useRef({ start: true, end: true });
  const editingRef = useRef(false);

  const owns = useCallback((target: EventTarget | null) => target instanceof Node && (
    groupRef.current?.contains(target) === true || [...surfaces.current.values()].some(element => element.contains(target))
  ), []);
  const begin = () => {
    if (editingRef.current) return;
    editingRef.current = true;
    originalRef.current = applied;
    if (error === null) {
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
    if (!validRef.current.start || !validRef.current.end) {
      setError('date');
      return;
    }
    if (interval.start >= interval.end) {
      setError('interval');
      return;
    }
    setError(null);
    if (interval.start !== originalRef.current.start || interval.end !== originalRef.current.end) {
      onChange(dashboardRangeFromInterval(interval.start, interval.end, Date.now()));
    }
  }, [onChange, onEditingChange]);

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
    setError(null);
    setOpenEndpoint(null);
    validRef.current = { start: true, end: true };
    draftRef.current = applied;
    setDraft(applied);
    setResetToken(current => current + 1);
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
  const startListboxRef = useCallback((element: HTMLDivElement | null) => registerSurface('start-listbox', element), [registerSurface]);
  const endListboxRef = useCallback((element: HTMLDivElement | null) => registerSurface('end-listbox', element), [registerSurface]);
  const shown = editing || error !== null ? draft : applied;

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
      onFocusCapture={begin}
      onKeyDownCapture={event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }}
      ref={groupRef}
    >
      <DateTimePicker
        label={t('dashboard.telemetry.range.start')}
        listboxRef={startListboxRef}
        onChange={handleStartChange}
        onOpenChange={open => { if (open) begin(); setOpenEndpoint(open ? 'start' : null); }}
        onValidityChange={valid => { validRef.current.start = valid; }}
        open={openEndpoint === 'start'}
        resetToken={resetToken}
        stepMs={TELEMETRY_HOUR_MS}
        surfaceRef={startSurfaceRef}
        value={shown.start}
      />
      <span>{t('dashboard.telemetry.range.to')}</span>
      <DateTimePicker
        label={t('dashboard.telemetry.range.end')}
        listboxRef={endListboxRef}
        onChange={handleEndChange}
        onOpenChange={open => { if (open) begin(); setOpenEndpoint(open ? 'end' : null); }}
        onValidityChange={valid => { validRef.current.end = valid; }}
        open={openEndpoint === 'end'}
        resetToken={resetToken}
        stepMs={TELEMETRY_HOUR_MS}
        surfaceRef={endSurfaceRef}
        value={shown.end}
      />
      <Text size={200} className="text-fui-fg2">{t(`dashboard.telemetry.range.aggregation.${dashboardGranularity(range, loadedAt)}`)}</Text>
    </div>
    {error !== null && <Text className={styles.error} role="alert" size={200}>{t(error === 'date' ? 'common.dateTime.invalidDate' : 'dashboard.telemetry.range.invalid')}</Text>}
  </div>;
}
