import { Fragment, useCallback, useEffect, useId, useRef, useState, type ComponentType } from 'react';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { calendarDate, parseCalendarDate } from '../../lib/calendar-date';
import { numericDate, numericDateTime } from '../../lib/format-time';
import { isCalendarRange, isResetRange, sameDashboardRange, type DashboardPreset, type DashboardRange, type DashboardResetRange } from '../charts/dashboard-time';
import { CalendarRange, type CalendarRangeSelection } from '../ui/calendar-range';
import { ChoiceGroup } from '../ui/choice-group';
import { LISTBOX_POSITIONING } from '../ui/fluent-form-controls';
import { ScrollArea } from '../ui/scroll-area';

const { Popover, PopoverSurface } = fluentComponents;
type RangePicker = 'custom' | 'reset-cycle';
export interface ResetCyclePickerControls {
  onApply: (range: DashboardResetRange) => void;
  onCancel: () => void;
}

export function TelemetryTimeRange<PickerProps extends object>({ addressOf, ariaLabel, loadedAt, onChange, onEditingChange, range, resetCyclePicker }: {
  addressOf: ((range: DashboardRange) => string) | null;
  ariaLabel: string;
  loadedAt: number;
  onChange: (range: DashboardRange) => void;
  onEditingChange: (editing: boolean) => void;
  range: DashboardRange;
  resetCyclePicker?: { component: ComponentType<PickerProps & ResetCyclePickerControls>; props: PickerProps };
}) {
  const { t } = useTranslation();
  const popupId = useId();
  const [draft, setDraft] = useState<CalendarRangeSelection>(isCalendarRange(range) ? range : { start: null, end: null });
  const [editing, setEditing] = useState(false);
  // Closing must not mount the other picker and let its autofocus steal the restored focus.
  const [picker, setPicker] = useState<RangePicker>('custom');
  const [session, setSession] = useState({ serial: 0, date: isCalendarRange(range) ? range.start : calendarDate(new Date(loadedAt)) });
  const [calendarAnchor, setCalendarAnchor] = useState<HTMLElement | null>(null);
  const [cycleAnchor, setCycleAnchor] = useState<HTMLElement | null>(null);
  const anchor = picker === 'reset-cycle' ? cycleAnchor : calendarAnchor;
  const CyclePicker = resetCyclePicker?.component;
  const groupRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const editingRef = useRef<RangePicker | null>(null);
  const owns = useCallback((target: EventTarget | null) => target instanceof Node && (
    groupRef.current?.contains(target) === true || surfaceRef.current?.contains(target) === true
  ), []);
  const close = useCallback(() => {
    if (!editingRef.current) return;
    editingRef.current = null;
    setEditing(false);
    onEditingChange(false);
  }, [onEditingChange]);
  const begin = (picker: RangePicker) => {
    if (editingRef.current === picker) return;
    if (picker === 'custom') {
      setDraft(isCalendarRange(range) ? range : { start: null, end: null });
    }
    setSession(current => ({ serial: current.serial + 1, date: isCalendarRange(range) ? range.start : calendarDate(new Date(loadedAt)) }));
    editingRef.current = picker;
    setPicker(picker);
    setEditing(true);
    onEditingChange(true);
  };
  const finish = useCallback((next?: DashboardRange) => {
    close();
    anchor?.focus({ preventScroll: true });
    if (next !== undefined && !sameDashboardRange(range, next)) onChange(next);
  }, [anchor, close, onChange, range]);
  const cancel = useCallback(() => finish(), [finish]);
  const select = (selection: CalendarRangeSelection) => {
    setDraft(selection);
    if (selection.start === null || selection.end === null) return;
    finish({ start: selection.start, end: selection.end });
  };
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (editingRef.current === 'custom' && !owns(event.target)) close();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [close, owns]);
  const blur = (target: EventTarget | null) => {
    if (editingRef.current !== 'custom') return;
    if (owns(target)) return;
    queueMicrotask(() => { if (editingRef.current === 'custom' && document.hasFocus() && !owns(document.activeElement)) close(); });
  };
  const showCaption = isCalendarRange(range);
  const formatEndpoint = (date: string) => numericDate(parseCalendarDate(date), true);
  return <div className="floway-telemetry-range" ref={groupRef} onBlurCapture={event => blur(event.relatedTarget)} onKeyDown={event => {
    if (event.key !== 'Escape' || !editingRef.current) return;
    event.preventDefault(); event.stopPropagation(); finish();
  }}>
    <div className="floway-telemetry-range-caption">
      {isCalendarRange(range) && <button aria-label={t('dashboard.telemetry.range.choose')} className="floway-telemetry-range-caption-button winui-focus-rect" onClick={() => begin('custom')} type="button">
        {formatEndpoint(range.start)}{' - '}{formatEndpoint(range.end)}
      </button>}
      {isResetRange(range) && <button aria-label={t('dashboard.telemetry.resetCycle.choose')} className="floway-telemetry-range-caption-button winui-focus-rect" onClick={() => begin('reset-cycle')} type="button">
        {t(range.cycle === 'current' ? 'dashboard.telemetry.range.currentReset' : 'dashboard.telemetry.range.previousReset')}{' · '}
        {numericDateTime(new Date(range.start))}{' - '}{numericDateTime(new Date(range.end))}
      </button>}
    </div>
    <ChoiceGroup ariaLabel={ariaLabel} items={[
      { value: 'today', label: t('dashboard.telemetry.range.oneDay'), ...(addressOf === null ? { button: true } : { to: addressOf('today') }) },
      { value: '7d', label: t('dashboard.telemetry.range.sevenDays'), ...(addressOf === null ? { button: true } : { to: addressOf('7d') }) },
      { value: '30d', label: t('dashboard.telemetry.range.thirtyDays'), ...(addressOf === null ? { button: true } : { to: addressOf('30d') }) },
      ...(resetCyclePicker === undefined ? [] : [{
        value: 'reset-cycle', label: t('dashboard.telemetry.range.byCycle'), button: true,
        elementRef: setCycleAnchor, ariaExpanded: editing && picker === 'reset-cycle', ariaControls: popupId,
      }]),
      { value: 'custom', label: t('dashboard.telemetry.range.custom'), button: true, elementRef: setCalendarAnchor, ariaExpanded: editing && picker === 'custom', ariaControls: popupId },
    ]} onChange={value => {
      if (value === 'custom' || value === 'reset-cycle') begin(value);
      else { close(); onChange(value as DashboardPreset); }
    }} value={editing ? picker : showCaption ? 'custom' : isResetRange(range) ? 'reset-cycle' : range as DashboardPreset} />
    <Popover open={editing} trapFocus={editing && picker === 'reset-cycle'} onOpenChange={(event, data) => {
      if (data.open) return;
      if (event.type === 'keydown' && 'key' in event && event.key === 'Escape') finish();
      else if (!owns(event.target)) close();
    }} positioning={{
      target: anchor ?? undefined, position: 'below', align: 'end', fallbackPositions: ['above'],
      ...(picker === 'reset-cycle' ? { autoSize: LISTBOX_POSITIONING.autoSize, overflowBoundaryPadding: LISTBOX_POSITIONING.overflowBoundaryPadding } : {}),
    }}>
      <PopoverSurface aria-label={t(picker === 'reset-cycle' ? 'dashboard.telemetry.resetCycle.choose' : 'dashboard.telemetry.range.choose')}
        className={picker === 'reset-cycle' ? 'w-[min(320px,calc(100vw-32px))] flex flex-col' : 'floway-date-range-surface'} id={popupId} onBlurCapture={event => blur(event.relatedTarget)} ref={surfaceRef}>
        <Fragment key={session.serial}>{picker === 'reset-cycle' ? <ScrollArea axes="vertical" className="floway-telemetry-range-scroller min-h-0" contentClassName="floway-telemetry-range-scroll-content" noTabIndex>
          {resetCyclePicker && CyclePicker && <CyclePicker {...resetCyclePicker.props} onApply={finish} onCancel={cancel} />}
        </ScrollArea>
          : <CalendarRange autoFocus displayDate={session.date} onChange={select} value={draft} />}</Fragment>
      </PopoverSurface>
    </Popover>
  </div>;
}
