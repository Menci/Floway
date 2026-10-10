import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { calendarDate, parseCalendarDate } from '../../lib/calendar-date';
import { numericDate } from '../../lib/format-time';
import { sameDashboardRange, type DashboardPreset, type DashboardRange } from '../charts/dashboard-time';
import { CalendarRange, type CalendarRangeSelection } from '../ui/calendar-range';
import { ChoiceGroup } from '../ui/choice-group';

const { Popover, PopoverSurface } = fluentComponents;

export function TelemetryTimeRange({ addressOf, ariaLabel, loadedAt, onChange, onEditingChange, range }: {
  addressOf: (range: DashboardRange) => string;
  ariaLabel: string;
  loadedAt: number;
  onChange: (range: DashboardRange) => void;
  onEditingChange: (editing: boolean) => void;
  range: DashboardRange;
}) {
  const { t } = useTranslation();
  const popupId = useId();
  const [draft, setDraft] = useState<CalendarRangeSelection>(typeof range === 'string' ? { start: null, end: null } : range);
  const [editing, setEditing] = useState(false);
  const [session, setSession] = useState({ serial: 0, date: typeof range === 'string' ? calendarDate(new Date(loadedAt)) : range.start });
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<CalendarRangeSelection>(draft);
  const editingRef = useRef(false);
  const setAnchorRef = useCallback((element: HTMLElement | null) => setAnchor(element), []);
  const owns = useCallback((target: EventTarget | null) => target instanceof Node && (
    groupRef.current?.contains(target) === true || surfaceRef.current?.contains(target) === true
  ), []);
  const close = useCallback((apply: boolean) => {
    if (!editingRef.current) return;
    editingRef.current = false;
    setEditing(false);
    onEditingChange(false);
    const selection = draftRef.current;
    if (apply && selection.start !== null && selection.end !== null) {
      const next = { start: selection.start, end: selection.end };
      if (!sameDashboardRange(range, next)) onChange(next);
    }
  }, [onChange, onEditingChange, range]);
  const begin = () => {
    if (editingRef.current) return;
    const selection = typeof range === 'string' ? { start: null, end: null } : range;
    draftRef.current = selection;
    setDraft(selection);
    setSession(current => ({ serial: current.serial + 1, date: typeof range === 'string' ? calendarDate(new Date(loadedAt)) : range.start }));
    editingRef.current = true;
    setEditing(true);
    onEditingChange(true);
  };
  const select = (selection: CalendarRangeSelection) => { draftRef.current = selection; setDraft(selection); };
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!owns(event.target)) close(true);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [close, owns]);
  const blur = (target: EventTarget | null) => {
    if (owns(target)) return;
    queueMicrotask(() => { if (document.hasFocus() && !owns(document.activeElement)) close(true); });
  };
  const showCaption = typeof range !== 'string';
  const formatEndpoint = (date: string) => numericDate(parseCalendarDate(date), true);
  return <div className="floway-telemetry-range" ref={groupRef} onBlurCapture={event => blur(event.relatedTarget)} onKeyDown={event => {
    if (event.key !== 'Escape' || !editingRef.current) return;
    event.preventDefault(); event.stopPropagation(); close(false);
  }}>
    <div className="floway-telemetry-range-caption">
      {typeof range !== 'string' && <button aria-label={t('dashboard.telemetry.range.choose')} className="floway-telemetry-range-caption-button winui-focus-rect" onClick={begin} type="button">
        {formatEndpoint(range.start)}{' - '}{formatEndpoint(range.end)}
      </button>}
    </div>
    <ChoiceGroup ariaLabel={ariaLabel} items={[
      { value: 'today', label: t('dashboard.telemetry.range.oneDay'), to: addressOf('today') },
      { value: '7d', label: t('dashboard.telemetry.range.sevenDays'), to: addressOf('7d') },
      { value: '30d', label: t('dashboard.telemetry.range.thirtyDays'), to: addressOf('30d') },
      { value: 'custom', label: t('dashboard.telemetry.range.custom'), button: true, elementRef: setAnchorRef, ariaExpanded: editing, ariaControls: popupId },
    ]} onChange={value => {
      if (value === 'custom') begin();
      else { close(false); onChange(value as DashboardPreset); }
    }} value={editing || showCaption ? 'custom' : range as DashboardPreset} />
    <Popover open={editing} onOpenChange={(event, data) => {
      if (data.open) return;
      if (event.type === 'keydown' && 'key' in event && event.key === 'Escape') close(false);
      else if (!owns(event.target)) close(true);
    }} positioning={{ target: anchor ?? undefined, position: 'below', align: 'end', fallbackPositions: ['above'] }}>
      <PopoverSurface aria-label={t('dashboard.telemetry.range.choose')} className="floway-date-range-surface" id={popupId} onBlurCapture={event => blur(event.relatedTarget)} ref={surfaceRef}>
        <CalendarRange autoFocus displayDate={session.date} key={session.serial} onChange={select} value={draft} />
      </PopoverSurface>
    </Popover>
  </div>;
}
