import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

import { CalendarNavigationIcon } from './calendar-navigation-icon';
import { useTranslation } from '../../i18n/translation';
import { calendarDate, parseCalendarDate } from '../../lib/calendar-date';
import { formatDate } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { RANGE_CELL_BORDER, RANGE_CELL_STROKE, RANGE_CELL_SIZE, RANGE_CONTENT_SIZE, RANGE_DRILL_EASING, RANGE_DRILL_MS, RANGE_DRILL_OUT_MS, RANGE_HEADER_FADE_MS, RANGE_LARGE_COLUMNS, RANGE_NAVIGATION_MS, RANGE_SNAPSHOT_MS, rangeNavigationFrames } from '../../winui/calendar-range';

export interface CalendarRangeSelection { start: string | null; end: string | null }
type Mode = 'month' | 'year' | 'decade' | 'century';
const modes: Mode[] = ['month', 'year', 'decade', 'century'];
// SfCalendarDateRangePicker's default bounds and NavigatorState range selection.
// https://www.nuget.org/packages/Syncfusion.Calendar.WinUI/35.1.39
const MIN_DATE = '1920-01-01';
const MAX_DATE = '2120-12-31';
const dateAt = (year: number, month = 0, day = 1) => { const date = new Date(0); date.setFullYear(year, month, day); date.setHours(0, 0, 0, 0); return date; };
const shiftDate = (mode: Mode, date: Date, count: number) => mode === 'month' ? dateAt(date.getFullYear(), date.getMonth(), date.getDate() + count) : mode === 'year' ? dateAt(date.getFullYear(), date.getMonth() + count) : dateAt(date.getFullYear() + count * (mode === 'century' ? 10 : 1));
const scope = (mode: Mode, date: Date) => mode === 'month' ? dateAt(date.getFullYear(), date.getMonth()) : dateAt(mode === 'year' ? date.getFullYear() : Math.floor(date.getFullYear() / (mode === 'decade' ? 10 : 100)) * (mode === 'decade' ? 10 : 100));
const scopeEnd = (mode: Mode, date: Date) => mode === 'month' ? dateAt(date.getFullYear(), date.getMonth() + 1, 0) : dateAt(date.getFullYear() + (mode === 'year' ? 1 : mode === 'decade' ? 10 : 100), 0, 0);
const cellDate = (mode: Mode, date: Date) => mode === 'month' ? date : mode === 'year' ? dateAt(date.getFullYear(), date.getMonth()) : dateAt(mode === 'century' ? Math.floor(date.getFullYear() / 10) * 10 : date.getFullYear());
const sameScope = (mode: Mode, left: Date, right: Date) => calendarDate(scope(mode, left)) === calendarDate(scope(mode, right));

const rangeAfterClick = (selection: CalendarRangeSelection, day: string): CalendarRangeSelection => {
  if (selection.start !== null && selection.end !== null && day >= selection.start && day <= selection.end) return { start: null, end: null };
  if (selection.start === null || selection.end !== null) return { start: day, end: null };
  return { start: day < selection.start ? day : selection.start, end: day < selection.start ? selection.start : day };
};

export function CalendarRange({ autoFocus = false, displayDate, onChange, value }: {
  autoFocus?: boolean;
  displayDate: string;
  onChange: (selection: CalendarRangeSelection) => void;
  value: CalendarRangeSelection;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [view, setView] = useState({ mode: 'month' as Mode, date: parseCalendarDate(displayDate), focused: displayDate });
  const { mode, date, focused } = view;
  const focusKey = calendarDate(cellDate(mode, parseCalendarDate(focused)));
  const firstWeekday = locale.startsWith('zh') ? 1 : 0;
  const panelRef = useRef<HTMLDivElement>(null);
  const snapshotsRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLButtonElement>(null);
  const focusAfterChange = useRef(autoFocus);
  const motion = useRef<{ kind: 'navigate' | 'up' | 'down'; direction: number } | null>(null);
  const snapshot = useRef<HTMLElement | null>(null);
  const animations = useRef<Animation[]>([]);
  const start = scope(mode, date);
  const end = scopeEnd(mode, start);
  const columns = mode === 'month' ? 7 : RANGE_LARGE_COLUMNS;
  const origin = mode === 'month' ? shiftDate('month', start, -(start.getDay() - firstWeekday + 7) % 7)
    : mode === 'year' ? start
      : mode === 'decade' ? dateAt(start.getFullYear() - (start.getFullYear() - 1) % RANGE_LARGE_COLUMNS)
        : dateAt(start.getFullYear() - start.getFullYear() / 10 % RANGE_LARGE_COLUMNS * 10);
  const cells = Array.from({ length: mode === 'month' ? 42 : 16 }, (_, index) => shiftDate(mode, origin, index));
  const header = mode === 'month' ? formatDate(date, locale, { month: 'long', year: 'numeric' })
    : mode === 'year' ? date.getFullYear().toLocaleString(locale, { useGrouping: false }) : `${start.getFullYear()} - ${end.getFullYear()}`;

  const transitionTo = (nextMode: Mode, nextDate: Date, nextFocus: string, transferFocus: boolean) => {
    const root = panelRef.current;
    const host = snapshotsRef.current;
    if (!root || !host) throw new Error('The range calendar must be mounted');
    animations.current.forEach(animation => animation.cancel());
    animations.current = [];
    host.replaceChildren();
    const kind = nextMode === mode ? 'navigate' : modes.indexOf(nextMode) > modes.indexOf(mode) ? 'up' : 'down';
    const target = kind === 'navigate' ? root.querySelector<HTMLElement>('.floway-range-grid')! : root;
    const copy = target.cloneNode(true) as HTMLElement;
    copy.classList.add('floway-range-snapshot');
    copy.setAttribute('aria-hidden', 'true');
    copy.inert = true;
    copy.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    copy.style.top = `${target.getBoundingClientRect().top - root.getBoundingClientRect().top}px`;
    copy.style.width = `${target.getBoundingClientRect().width}px`;
    host.append(copy);
    snapshot.current = copy;
    motion.current = { kind, direction: nextDate.getTime() < date.getTime() ? -1 : 1 };
    focusAfterChange.current = transferFocus || nextMode === 'century';
    setView({ mode: nextMode, date: nextDate, focused: nextFocus });
  };
  const navigate = (direction: number, transferFocus = false) => {
    const next = mode === 'month' ? dateAt(date.getFullYear(), date.getMonth() + direction) : dateAt(date.getFullYear() + direction * (mode === 'year' ? 1 : mode === 'decade' ? 10 : 100));
    transitionTo(mode, next, calendarDate(next), transferFocus);
  };
  const select = (selected: Date) => {
    const key = calendarDate(selected);
    if (mode === 'month') {
      setView(current => ({ ...current, focused: key }));
      onChange(rangeAfterClick(value, key));
    } else transitionTo(modes[modes.indexOf(mode) - 1], selected, key, true);
  };
  useLayoutEffect(() => {
    if (focusAfterChange.current) {
      panelRef.current?.querySelector<HTMLButtonElement>(`button[data-date="${focusKey}"]`)?.focus({ preventScroll: true });
      focusAfterChange.current = false;
    }
    const transition = motion.current;
    const old = snapshot.current;
    const panel = panelRef.current;
    if (!transition || !old || !panel) return;
    motion.current = null;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { old.remove(); return; }
    const headerAnimation = headerRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: RANGE_HEADER_FADE_MS, fill: 'both' });
    if (headerAnimation) animations.current.push(headerAnimation);
    if (transition.kind === 'navigate') {
      const target = panel.querySelector<HTMLElement>('.floway-range-grid')!;
      const distance = transition.direction * RANGE_CONTENT_SIZE;
      const outgoing = old.animate(rangeNavigationFrames(distance, false), { duration: RANGE_NAVIGATION_MS, fill: 'both' });
      const incoming = target.animate(rangeNavigationFrames(distance, true), { duration: RANGE_NAVIGATION_MS, fill: 'both' });
      const hide = old.animate([{ visibility: 'visible' }, { visibility: 'hidden' }], { duration: 0, delay: RANGE_SNAPSHOT_MS, fill: 'both' });
      incoming.addEventListener('finish', () => { old.remove(); incoming.cancel(); }, { once: true });
      animations.current.push(outgoing, incoming, hide);
    } else {
      const upward = transition.kind === 'up';
      const outgoing = old.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: `scale(${upward ? 0.84 : 1.29})` }], { duration: RANGE_DRILL_OUT_MS, easing: RANGE_DRILL_EASING, fill: 'both' });
      const incoming = panel.animate([{ opacity: 0, transform: `scale(${upward ? 1.29 : 0.84})` }, { opacity: 1, transform: 'scale(1)' }], { duration: RANGE_DRILL_MS - RANGE_DRILL_OUT_MS, delay: RANGE_DRILL_OUT_MS, easing: RANGE_DRILL_EASING, fill: 'both' });
      outgoing.addEventListener('finish', () => old.remove(), { once: true });
      incoming.addEventListener('finish', () => incoming.cancel(), { once: true });
      animations.current.push(outgoing, incoming);
    }
  }, [view, focusKey]);
  useLayoutEffect(() => () => animations.current.forEach(animation => animation.cancel()), []);
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, current: Date) => {
    if (event.ctrlKey && event.key === 'ArrowUp' && mode !== 'century') {
      event.preventDefault(); transitionTo(modes[modes.indexOf(mode) + 1], current, calendarDate(current), true); return;
    }
    if (event.ctrlKey && event.key === 'ArrowDown' && mode !== 'month') { event.preventDefault(); select(current); return; }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'PageUp' || event.key === 'PageDown') { event.preventDefault(); navigate(event.key === 'PageUp' ? -1 : 1, true); return; }
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -columns : event.key === 'ArrowDown' ? columns : null;
    const next = event.key === 'Home' ? start : event.key === 'End' ? end : step === null ? null : shiftDate(mode, current, step);
    if (!next || calendarDate(next) < MIN_DATE || calendarDate(next) > MAX_DATE) return;
    event.preventDefault();
    const key = calendarDate(next);
    if (cells.some(cell => calendarDate(cell) === key && sameScope(mode, cell, date))) {
      setView(previous => ({ ...previous, focused: key }));
      panelRef.current?.querySelector<HTMLButtonElement>(`button[data-date="${key}"]`)?.focus({ preventScroll: true });
    } else transitionTo(mode, next, key, true);
  };
  const [today] = useState(() => parseCalendarDate(calendarDate(new Date(Date.now()))));
  const cellSize = mode === 'month' ? RANGE_CELL_SIZE : RANGE_CONTENT_SIZE / RANGE_LARGE_COLUMNS;
  const circleSize = cellSize - 2 * RANGE_CELL_BORDER;
  const radius = circleSize / 2;
  // Native Path layout includes the positive half-stroke extent and rounds up;
  // its geometry remains 36px inside the centered 37px month-cell layout slot.
  // https://www.nuget.org/packages/Syncfusion.Calendar.WinUI/35.1.39
  const shapeLayoutSize = Math.ceil(circleSize + RANGE_CELL_STROKE / 2);
  const shapeOffset = (cellSize - shapeLayoutSize) / 2;
  const circleCenter = shapeOffset + radius;
  return <div className="floway-range-calendar" data-view={mode}>
    <div className="floway-range-header">
      <button aria-label={t(mode === 'month' ? 'common.calendar.previousMonth' : mode === 'year' ? 'common.calendar.previousYear' : mode === 'decade' ? 'common.calendar.previousDecade' : 'common.calendar.previousCentury')} className="floway-range-navigation" disabled={calendarDate(start) <= MIN_DATE} onClick={() => navigate(-1)} type="button"><CalendarNavigationIcon direction="left" /></button>
      <button aria-label={mode === 'century' ? header : t(mode === 'month' ? 'common.calendar.chooseMonth' : mode === 'year' ? 'common.calendar.chooseYear' : 'common.calendar.chooseDecade').replace('{0}', header)} className="floway-range-heading" disabled={mode === 'century'} onClick={() => transitionTo(modes[modes.indexOf(mode) + 1], date, focused, false)} ref={headerRef} type="button">{header}</button>
      <button aria-label={t(mode === 'month' ? 'common.calendar.nextMonth' : mode === 'year' ? 'common.calendar.nextYear' : mode === 'decade' ? 'common.calendar.nextDecade' : 'common.calendar.nextCentury')} className="floway-range-navigation" disabled={calendarDate(end) >= MAX_DATE} onClick={() => navigate(1)} type="button"><CalendarNavigationIcon direction="right" /></button>
    </div>
    <div className="floway-range-viewport">
      <div className="floway-range-view" ref={panelRef}>
        {mode === 'month' && <div className="floway-range-weekdays" role="row">{Array.from({ length: 7 }, (_, index) => dateAt(2026, 5, 7 + firstWeekday + index)).map(day => <span aria-label={day.toLocaleDateString(locale, { weekday: 'long' })} key={day.getDay()} role="columnheader">{day.toLocaleDateString(locale, { weekday: 'short' }).slice(0, 2)}</span>)}</div>}
        <div aria-label={header} className="floway-range-grid" role="grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)`, gridTemplateRows: `repeat(${mode === 'month' ? 6 : 4}, 1fr)` }}>
          {Array.from({ length: mode === 'month' ? 6 : 4 }, (_, row) => <div className="floway-range-row" key={row} role="row">{cells.slice(row * columns, (row + 1) * columns).map(cell => {
            const key = calendarDate(cell);
            const last = mode === 'month' ? key : calendarDate(mode === 'year' ? dateAt(cell.getFullYear(), cell.getMonth() + 1, 0) : dateAt(cell.getFullYear() + (mode === 'century' ? 10 : 1), 0, 0));
            const endpoint = value.start !== null && key <= value.start && value.start <= last ? 'start' : value.end !== null && key <= value.end && value.end <= last ? 'end' : undefined;
            const inRange = value.start !== null && value.end !== null && key > value.start && last < value.end;
            const single = endpoint === 'start' && value.end !== null && key <= value.end && value.end <= last;
            const current = mode === 'month' ? calendarDate(today) === key : mode === 'year' ? cell.getFullYear() === today.getFullYear() && cell.getMonth() === today.getMonth() : today.getFullYear() >= cell.getFullYear() && today.getFullYear() < cell.getFullYear() + (mode === 'century' ? 10 : 1);
            const label = mode === 'month' ? String(cell.getDate()) : mode === 'year' ? formatDate(cell, locale, { month: 'short' }) : mode === 'decade' ? String(cell.getFullYear()) : `${cell.getFullYear()}-\n${cell.getFullYear() + 9}`;
            const rangeStart = endpoint === 'start';
            const arcRadius = radius + (rangeStart ? -RANGE_CELL_STROKE : RANGE_CELL_STROKE);
            const bandEdge = rangeStart ? cellSize : 0;
            return <button aria-current={current ? 'date' : undefined} aria-label={mode === 'month' ? formatDate(cell, locale, { year: 'numeric', month: 'long', day: 'numeric' }) : label.replace('\n', '')} aria-selected={endpoint !== undefined || inRange} aria-hidden={!sameScope(mode, cell, date) || undefined} className="floway-range-cell" data-date={key} data-endpoint={endpoint} data-in-range={inRange || undefined} data-single={single || undefined} data-today={current || undefined} data-outside={!sameScope(mode, cell, date) || undefined} disabled={key > MAX_DATE || last < MIN_DATE || !sameScope(mode, cell, date)} key={key} onClick={() => select(cell)} onKeyDown={event => keyDown(event, cell)} role="gridcell" tabIndex={key === focusKey ? 0 : -1} type="button">
              <svg aria-hidden="true" className="floway-range-cell-paint" viewBox={`0 0 ${cellSize} ${cellSize}`}>
                {inRange && <rect className="floway-range-band" width={cellSize} height={shapeLayoutSize} y={shapeOffset} />}
                {endpoint && !single && value.end !== null && <path className="floway-range-band" d={`M ${bandEdge} ${shapeOffset} L ${circleSize / 2} ${shapeOffset} A ${arcRadius} ${radius} 0 0 ${rangeStart ? 0 : 1} ${circleSize / 2} ${shapeOffset + circleSize + RANGE_CELL_STROKE / 2} L ${bandEdge} ${shapeOffset + circleSize + RANGE_CELL_STROKE / 2} Z`} />}
                <circle className="floway-range-circle" cx={circleCenter} cy={circleCenter} r={radius} strokeWidth={RANGE_CELL_STROKE} />
                {current && endpoint && <circle className="floway-range-inner-circle" cx={circleCenter} cy={circleCenter} r={radius * 0.9} />}
              </svg>
              <span>{label}</span>
            </button>;
          })}</div>)}
        </div>
      </div>
      <div aria-hidden="true" className="floway-range-snapshots" ref={snapshotsRef} />
    </div>
  </div>;
}
