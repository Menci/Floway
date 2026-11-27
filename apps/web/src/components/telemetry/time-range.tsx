import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { ResetCyclePicker } from './reset-cycle-picker';
import { readResetCycles } from './reset-cycles';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { calendarDate, parseCalendarDate } from '../../lib/calendar-date';
import { numericDate, numericDateTime } from '../../lib/format-time';
import { isCalendarRange, isResetRange, sameDashboardRange, type DashboardPreset, type DashboardRange } from '../charts/dashboard-time';
import { CalendarRange, type CalendarRangeSelection } from '../ui/calendar-range';
import { ChoiceGroup } from '../ui/choice-group';
import { LISTBOX_POSITIONING } from '../ui/fluent-form-controls';
import { ScrollArea } from '../ui/scroll-area';

const { Popover, PopoverSurface } = fluentComponents;
type RangePicker = 'custom' | 'reset-cycle';

export function TelemetryTimeRange({ addressOf, ariaLabel, disabled = false, loadedAt, onChange, onEditingChange, range, resetUpstreamId = null }: {
  addressOf: ((range: DashboardRange) => string) | null;
  ariaLabel: string;
  disabled?: boolean;
  loadedAt: number;
  onChange: (range: DashboardRange) => void;
  onEditingChange: (editing: boolean) => void;
  range: DashboardRange;
  resetUpstreamId?: string | null;
}) {
  const { t } = useTranslation();
  const popupId = useId();
  const [draft, setDraft] = useState<CalendarRangeSelection>(isCalendarRange(range) ? range : { start: null, end: null });
  const [session, setSession] = useState({ serial: 0, date: isCalendarRange(range) ? range.start : calendarDate(new Date(loadedAt)), picker: 'custom' as RangePicker, open: false });
  const [calendarAnchor, setCalendarAnchor] = useState<HTMLElement | null>(null);
  const [cycleAnchor, setCycleAnchor] = useState<HTMLElement | null>(null);
  const [capability, setCapability] = useState<{ upstreamId: string; supported: boolean }>();
  const cycleAvailable = resetUpstreamId !== null && (isResetRange(range)
    || (capability?.upstreamId === resetUpstreamId && capability.supported));
  const { picker, open } = session;
  const isCyclePicker = picker === 'reset-cycle';
  const anchor = isCyclePicker ? cycleAnchor : calendarAnchor;
  const groupRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const editingRef = useRef<RangePicker | null>(null);
  const owns = useCallback((target: EventTarget | null) => target instanceof Node && (
    groupRef.current?.contains(target) === true || surfaceRef.current?.contains(target) === true
  ), []);
  const close = useCallback(() => {
    if (!editingRef.current) return;
    editingRef.current = null;
    setSession(current => ({ ...current, open: false }));
    onEditingChange(false);
  }, [onEditingChange]);
  const begin = (next: RangePicker) => {
    if (editingRef.current === next) return;
    const selection = isCalendarRange(range) ? range : { start: null, end: null };
    if (next === 'custom') setDraft(selection);
    setSession(current => ({ serial: current.serial + 1, date: selection.start ?? calendarDate(new Date(loadedAt)), picker: next, open: true }));
    editingRef.current = next;
    onEditingChange(true);
  };
  const finish = (next?: DashboardRange) => {
    close();
    anchor?.focus({ preventScroll: true });
    if (next !== undefined && !sameDashboardRange(range, next)) onChange(next);
  };
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
  useEffect(() => {
    if (resetUpstreamId === null) return;
    const controller = new AbortController();
    void readResetCycles(resetUpstreamId, Date.now(), controller.signal, { view: 'availability' }).then(result => {
      // A failed capability check leaves the picker available for an explicit retry.
      if (!controller.signal.aborted) setCapability({ upstreamId: resetUpstreamId, supported: result.data?.supported ?? true });
    });
    return () => controller.abort();
  }, [resetUpstreamId]);
  useEffect(() => {
    if (!cycleAvailable && editingRef.current === 'reset-cycle') close();
  }, [close, cycleAvailable]);
  const blur = (target: EventTarget | null) => {
    if (editingRef.current !== 'custom' || owns(target)) return;
    queueMicrotask(() => { if (editingRef.current === 'custom' && document.hasFocus() && !owns(document.activeElement)) close(); });
  };
  const formatEndpoint = (date: string) => numericDate(parseCalendarDate(date), true);
  return <div className="floway-telemetry-range ml-auto" data-reset-cycles={cycleAvailable || undefined} inert={disabled} ref={groupRef} onBlurCapture={event => blur(event.relatedTarget)} onKeyDown={event => {
    if (event.key !== 'Escape' || !editingRef.current) return;
    event.preventDefault(); event.stopPropagation(); finish();
  }}>
    <div className="floway-telemetry-range-caption">
      {isCalendarRange(range) && <button aria-label={t('monitoring.controls.range.choose')} className="floway-telemetry-range-caption-button winui-focus-rect" onClick={() => begin('custom')} type="button">
        {formatEndpoint(range.start)}{' - '}{formatEndpoint(range.end)}
      </button>}
      {isResetRange(range) && cycleAvailable && <button aria-label={t('monitoring.controls.resetCycle.choose')} className="floway-telemetry-range-caption-button winui-focus-rect" onClick={() => begin('reset-cycle')} type="button">
        {numericDateTime(new Date(range.start))}{' - '}{numericDateTime(new Date(range.end ?? loadedAt))}
      </button>}
    </div>
    <ChoiceGroup ariaLabel={ariaLabel} items={[
      { value: 'today', label: t('monitoring.controls.range.oneDay'), ...(addressOf === null ? { button: true } : { to: addressOf('today') }) },
      { value: '7d', label: t('monitoring.controls.range.sevenDays'), ...(addressOf === null ? { button: true } : { to: addressOf('7d') }) },
      { value: '30d', label: t('monitoring.controls.range.thirtyDays'), ...(addressOf === null ? { button: true } : { to: addressOf('30d') }) },
      ...(!cycleAvailable ? [] : [{
        value: 'reset-cycle', label: t('monitoring.controls.resetCycle.filter'), button: true,
        elementRef: setCycleAnchor, ariaExpanded: open && isCyclePicker, ariaControls: popupId,
      }]),
      { value: 'custom', label: t('monitoring.controls.range.custom'), button: true, elementRef: setCalendarAnchor, ariaExpanded: open && !isCyclePicker, ariaControls: popupId },
    ]} onChange={value => {
      if (value === 'custom' || value === 'reset-cycle') begin(value);
      else { close(); onChange(value as DashboardPreset); }
    }} value={open ? picker : isCalendarRange(range) ? 'custom' : isResetRange(range) ? 'reset-cycle' : range} />
    <Popover open={open} trapFocus={isCyclePicker} onOpenChange={(event, data) => {
      if (data.open) return;
      if (event.type === 'keydown' && 'key' in event && event.key === 'Escape') finish();
      else if (!owns(event.target)) close();
    }} positioning={{
      ...(anchor === null ? {} : { target: anchor }), position: 'below', align: 'end', fallbackPositions: ['above'],
      ...(isCyclePicker && { autoSize: LISTBOX_POSITIONING.autoSize, overflowBoundaryPadding: LISTBOX_POSITIONING.overflowBoundaryPadding }),
    }}>
      <PopoverSurface aria-label={t(isCyclePicker ? 'monitoring.controls.resetCycle.choose' : 'monitoring.controls.range.choose')}
        className={isCyclePicker ? 'floway-reset-cycle-surface' : 'floway-date-range-surface'} id={popupId}
        onBlurCapture={event => blur(event.relatedTarget)} ref={surfaceRef}>
        {isCyclePicker
          ? <ScrollArea axes="vertical" className="floway-reset-cycle-scroller" contentClassName="floway-reset-cycle-scroll-content" noTabIndex>
              {resetUpstreamId !== null && <ResetCyclePicker upstreamId={resetUpstreamId} key={`${resetUpstreamId}:${session.serial}`} loadedAt={loadedAt} range={range} onApply={finish} onCancel={() => finish()} />}
            </ScrollArea>
          : <CalendarRange autoFocus displayDate={session.date} key={session.serial} onChange={select} value={draft} />}
      </PopoverSurface>
    </Popover>
  </div>;
}
