import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { calendarDate, parseCalendarDate } from '../../lib/calendar-date';
import { numericDate, numericDateTime } from '../../lib/format-time';
import { isCalendarRange, isResetRange, sameDashboardRange, type DashboardPreset, type DashboardRange, type DashboardResetRange } from '../charts/dashboard-time';
import { CalendarRange, type CalendarRangeSelection } from '../ui/calendar-range';
import { ChoiceGroup } from '../ui/choice-group';

const { Popover, PopoverSurface } = fluentComponents;

export function TelemetryTimeRange({ addressOf, ariaLabel, loadedAt, onChange, onEditingChange, range, resetRanges }: {
  addressOf: ((range: DashboardRange) => string) | null;
  ariaLabel: string;
  loadedAt: number;
  onChange: (range: DashboardRange) => void;
  onEditingChange: (editing: boolean) => void;
  range: DashboardRange;
  resetRanges?: Record<DashboardResetRange['cycle'], DashboardResetRange | null>;
}) {
  const { t } = useTranslation();
  const popupId = useId();
  const [draft, setDraft] = useState<CalendarRangeSelection>(isCalendarRange(range) ? range : { start: null, end: null });
  const [editing, setEditing] = useState(false);
  const [session, setSession] = useState({ serial: 0, date: isCalendarRange(range) ? range.start : calendarDate(new Date(loadedAt)) });
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const editingRef = useRef(false);
  const setAnchorRef = useCallback((element: HTMLElement | null) => setAnchor(element), []);
  const owns = useCallback((target: EventTarget | null) => target instanceof Node && (
    groupRef.current?.contains(target) === true || surfaceRef.current?.contains(target) === true
  ), []);
  const close = useCallback(() => {
    if (!editingRef.current) return;
    editingRef.current = false;
    setEditing(false);
    onEditingChange(false);
  }, [onEditingChange]);
  const begin = () => {
    if (editingRef.current) return;
    const selection = isCalendarRange(range) ? range : { start: null, end: null };
    setDraft(selection);
    setSession(current => ({ serial: current.serial + 1, date: isCalendarRange(range) ? range.start : calendarDate(new Date(loadedAt)) }));
    editingRef.current = true;
    setEditing(true);
    onEditingChange(true);
  };
  const select = (selection: CalendarRangeSelection) => {
    setDraft(selection);
    if (selection.start === null || selection.end === null) return;
    close();
    anchor?.focus({ preventScroll: true });
    const next = { start: selection.start, end: selection.end };
    if (!sameDashboardRange(range, next)) onChange(next);
  };
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!owns(event.target)) close();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [close, owns]);
  const blur = (target: EventTarget | null) => {
    if (owns(target)) return;
    queueMicrotask(() => { if (document.hasFocus() && !owns(document.activeElement)) close(); });
  };
  const showCaption = isCalendarRange(range);
  const formatEndpoint = (date: string) => numericDate(parseCalendarDate(date), true);
  return <div className="floway-telemetry-range" ref={groupRef} onBlurCapture={event => blur(event.relatedTarget)} onKeyDown={event => {
    if (event.key !== 'Escape' || !editingRef.current) return;
    event.preventDefault(); event.stopPropagation(); close();
  }}>
    <div className="floway-telemetry-range-caption">
      {isCalendarRange(range) && <button aria-label={t('dashboard.telemetry.range.choose')} className="floway-telemetry-range-caption-button winui-focus-rect" onClick={begin} type="button">
        {formatEndpoint(range.start)}{' - '}{formatEndpoint(range.end)}
      </button>}
      {isResetRange(range) && <span>{numericDateTime(new Date(range.start))}{' - '}{numericDateTime(new Date(range.end))}</span>}
    </div>
    <ChoiceGroup ariaLabel={ariaLabel} items={[
      { value: 'today', label: t('dashboard.telemetry.range.oneDay'), ...(addressOf === null ? { button: true } : { to: addressOf('today') }) },
      { value: '7d', label: t('dashboard.telemetry.range.sevenDays'), ...(addressOf === null ? { button: true } : { to: addressOf('7d') }) },
      { value: '30d', label: t('dashboard.telemetry.range.thirtyDays'), ...(addressOf === null ? { button: true } : { to: addressOf('30d') }) },
      ...(resetRanges === undefined ? [] : (['current', 'previous'] as const).map(cycle => {
        const next = resetRanges[cycle];
        return {
          value: `reset-${cycle}`, label: t(cycle === 'current' ? 'dashboard.telemetry.range.currentReset' : 'dashboard.telemetry.range.previousReset'), disabled: next === null,
          ...(addressOf === null || next === null ? { button: true } : { to: addressOf(next) }),
        };
      })),
      { value: 'custom', label: t('dashboard.telemetry.range.custom'), button: true, elementRef: setAnchorRef, ariaExpanded: editing, ariaControls: popupId },
    ]} onChange={value => {
      if (value === 'custom') begin();
      else if (value === 'reset-current' || value === 'reset-previous') {
        const next = resetRanges?.[value === 'reset-current' ? 'current' : 'previous'];
        if (next) { close(); onChange(next); }
      } else { close(); onChange(value as DashboardPreset); }
    }} value={editing || showCaption ? 'custom' : isResetRange(range) ? `reset-${range.cycle}` : range as DashboardPreset} />
    <Popover open={editing} onOpenChange={(event, data) => {
      if (data.open) return;
      if (event.type === 'keydown' && 'key' in event && event.key === 'Escape') close();
      else if (!owns(event.target)) close();
    }} positioning={{ target: anchor ?? undefined, position: 'below', align: 'end', fallbackPositions: ['above'] }}>
      <PopoverSurface aria-label={t('dashboard.telemetry.range.choose')} className="floway-date-range-surface" id={popupId} onBlurCapture={event => blur(event.relatedTarget)} ref={surfaceRef}>
        <CalendarRange autoFocus displayDate={session.date} key={session.serial} onChange={select} value={draft} />
      </PopoverSurface>
    </Popover>
  </div>;
}
