import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';

import { CalendarChevron } from './calendar-chevron';
import { useTranslation } from '../../i18n/translation';
import { useLocale } from '../../lib/use-locale';
import { CALENDAR_DAY_MIN_SIZE, CALENDAR_ROW_SIZE } from '../../winui/calendar';
import { CALENDAR_DRILL_IN_MS, CALENDAR_DRILL_OUT_MS, CALENDAR_HEADER_FADE_MS, CONTROL_FAST_OUT_SLOW_IN_EASING } from '../../winui/motion';

type Mode = 'month' | 'year' | 'decade';
const modes: Mode[] = ['month', 'year', 'decade'];
const DAY_MS = 86_400_000;
const dateAt = (year: number, month = 0, date = 1) => { const result = new Date(0); result.setFullYear(year, month, date); result.setHours(0, 0, 0, 0); return result; };
const utcDay = (date: Date) => { const result = new Date(0); result.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate()); result.setUTCHours(0, 0, 0, 0); return result.getTime() / DAY_MS; };
const fromDay = (ordinal: number) => { const date = new Date(ordinal * DAY_MS); return dateAt(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()); };
const sameDay = (left: Date, right: Date) => utcDay(left) === utcDay(right);
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const unitOf = (mode: Mode, date: Date) => mode === 'month' ? utcDay(date) : mode === 'year' ? date.getFullYear() * 12 + date.getMonth() : date.getFullYear();
const dateOf = (mode: Mode, unit: number) => mode === 'month' ? fromDay(unit) : mode === 'year' ? dateAt(Math.floor(unit / 12), ((unit % 12) + 12) % 12) : dateAt(unit);
const copyDate = (mode: Mode, target: Date, source: Date) => {
  if (mode === 'month') return target;
  const year = target.getFullYear();
  const month = mode === 'year' ? target.getMonth() : source.getMonth();
  return dateAt(year, month, Math.min(source.getDate(), dateAt(year, month + 1, 0).getDate()));
};
const scopeStart = (mode: Mode, date: Date) => mode === 'month' ? utcDay(dateAt(date.getFullYear(), date.getMonth())) : mode === 'year' ? date.getFullYear() * 12 : date.getFullYear() - date.getFullYear() % 10;

interface Viewport { first: number; before: boolean; after: boolean; rows: number; columns: number }

interface PanelProps {
  mode: Mode;
  display: Date;
  value: Date;
  minDate: Date;
  maxDate: Date;
  onScope: (date: Date) => void;
  onViewport: (viewport: Viewport) => void;
  onSelect: (date: Date) => void;
  onDrillUp: (date: Date) => void;
  getFocusedDate: () => Date;
  onFocusDate: (date: Date) => void;
  navigation: { serial: number; date: Date; focus: boolean };
}

function CalendarPanel({ mode, display, value, minDate, maxDate, navigation, onScope, onSelect, onDrillUp, getFocusedDate, onFocusDate, onViewport }: PanelProps) {
  const { t } = useTranslation();
  const locale = useLocale();
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef<HTMLButtonElement>(null);
  const minimum = unitOf(mode, minDate);
  const maximum = unitOf(mode, maxDate);
  const [dimensions, setDimensions] = useState({ columns: mode === 'month' ? 7 : 4, rows: mode === 'month' ? 6 : 4, rowSize: CALENDAR_ROW_SIZE });
  const { columns, rows, rowSize } = dimensions;
  const origin = mode === 'month' ? minimum - minDate.getDay() : minimum;
  const lastRow = Math.ceil((maximum - origin + 1) / columns);
  const targetRow = Math.floor((scopeStart(mode, navigation.date) - origin) / columns);
  const [firstVisible, setFirstVisible] = useState(targetRow);
  const [focusState, setFocusState] = useState({ serial: navigation.serial, unit: unitOf(mode, navigation.date) });
  const focused = focusState.serial === navigation.serial ? focusState.unit : unitOf(mode, navigation.date);
  const setFocused = (unit: number) => setFocusState({ serial: navigation.serial, unit });
  const didPosition = useRef(false);
  const today = new Date();

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) throw new Error('The calendar viewport must be mounted');
    if (mode !== 'month') {
      const samples = [...scroll.querySelectorAll<HTMLSpanElement>('.floway-calendar-item > span')];
      const width = Math.max(CALENDAR_DAY_MIN_SIZE, ...samples.map(element => element.getBoundingClientRect().width)) + 18;
      const height = Math.max(CALENDAR_DAY_MIN_SIZE, ...samples.map(element => element.getBoundingClientRect().height)) + 18;
      const measured = {
        columns: Math.max(1, Math.min(4, Math.floor(scroll.clientWidth / width))),
        rows: Math.max(1, Math.min(4, Math.floor(scroll.clientHeight / height))),
      };
      setDimensions({ ...measured, rowSize: scroll.clientHeight / measured.rows });
    }
  }, [mode, locale]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) throw new Error('The calendar viewport must be mounted');
    scroll.scrollTo({ top: targetRow * rowSize, behavior: didPosition.current && !reduceMotion() ? 'smooth' : 'instant' });
    const row = Math.floor(scroll.scrollTop / rowSize);
    onViewport({ first: dateOf(mode, Math.max(minimum, origin + row * columns)).getTime(), before: origin + row * columns > minimum, after: origin + (row + rows) * columns - 1 < maximum, rows, columns });
    didPosition.current = true;
    if (navigation.focus) focusedRef.current?.focus({ preventScroll: true });
  }, [navigation.serial, navigation.focus, targetRow, rowSize, columns, rows, origin, minimum, maximum, mode, onViewport]);

  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, unit: number) => {
    const date = getFocusedDate();
    const controlOnly = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
    if (controlOnly && event.key === 'ArrowUp') { event.preventDefault(); onDrillUp(date); return; }
    if (controlOnly && event.key === 'ArrowDown') { if (mode !== 'month') { event.preventDefault(); onSelect(date); } return; }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    let candidate: number;
    if (event.key === 'Home') candidate = scopeStart(mode, display);
    else if (event.key === 'End') candidate = mode === 'month' ? utcDay(dateAt(display.getFullYear(), display.getMonth() + 1, 0)) : mode === 'year' ? display.getFullYear() * 12 + 11 : scopeStart(mode, display) + 9;
    else if (event.key === 'PageUp' || event.key === 'PageDown') {
      const direction = event.key === 'PageUp' ? -1 : 1;
      const target = mode === 'month' ? dateAt(date.getFullYear(), date.getMonth() + direction) : dateAt(date.getFullYear() + direction * (mode === 'year' ? 1 : 10), date.getMonth());
      if (mode === 'month') target.setDate(Math.min(date.getDate(), dateAt(target.getFullYear(), target.getMonth() + 1, 0).getDate()));
      candidate = unitOf(mode, target);
    } else {
      const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -columns : event.key === 'ArrowDown' ? columns : null;
      if (step === null) return;
      candidate = unit + step;
      if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && (candidate < minimum || candidate > maximum)) return;
    }
    event.preventDefault();
    const next = Math.max(minimum, Math.min(maximum, candidate));
    setFocused(next);
    onFocusDate(dateOf(mode, next));
    const row = Math.floor((next - origin) / columns);
    const scroll = scrollRef.current;
    if (!scroll) throw new Error('The calendar viewport must be mounted');
    const visible = scroll.scrollTop / rowSize;
    if (row < visible || row >= visible + rows) scroll.scrollTo({ top: Math.max(0, row < visible ? row : row - rows + 1) * rowSize, behavior: reduceMotion() ? 'instant' : 'smooth' });
    setFirstVisible(Math.floor(scroll.scrollTop / rowSize));
    requestAnimationFrame(() => focusedRef.current?.focus({ preventScroll: true }));
  };
  const start = Math.max(0, firstVisible - rows);
  const end = Math.min(lastRow, firstVisible + rows * 2);
  return <div className={mode === 'month' ? 'floway-calendar-scroll' : 'floway-calendar-scroll floway-calendar-large-scroll'} ref={scrollRef} onScroll={event => {
    const row = Math.floor(event.currentTarget.scrollTop / rowSize);
    setFirstVisible(row);
    onViewport({ first: dateOf(mode, Math.max(minimum, origin + row * columns)).getTime(), before: origin + row * columns > minimum, after: origin + (row + rows) * columns - 1 < maximum, rows, columns });
    const lastVisible = Math.min(maximum, origin + (row + rows) * columns - 1);
    const coverage = new Map<number, { date: Date; count: number; size: number }>();
    for (let unit = Math.max(minimum, origin + row * columns); unit <= lastVisible; unit++) {
      const date = dateOf(mode, unit);
      const key = scopeStart(mode, date);
      const scope = coverage.get(key);
      if (scope) scope.count++;
      else coverage.set(key, { date, count: 1, size: mode === 'month' ? dateAt(date.getFullYear(), date.getMonth() + 1, 0).getDate() : mode === 'year' ? 12 : 10 });
    }
    let winner: { date: Date; count: number; size: number } | null = null;
    for (const scope of coverage.values()) if (winner === null || scope.count / scope.size > winner.count / winner.size) winner = scope;
    if (winner && scopeStart(mode, winner.date) !== scopeStart(mode, display)) onScope(winner.date);
  }}>
    <div className="floway-calendar-plane" style={{ height: lastRow * rowSize }}>
      {Array.from({ length: end - start }, (_, index) => {
        const row = start + index;
        return <div className="floway-calendar-row" aria-hidden={row < firstVisible || row >= firstVisible + rows} key={row} role="row" style={{ top: row * rowSize, height: rowSize, gridTemplateColumns: `repeat(${  columns  }, 1fr)` }}>
          {Array.from({ length: columns }, (_, column) => {
            const unit = origin + row * columns + column;
            const date = dateOf(mode, unit);
            const selected = mode === 'month' && sameDay(date, value);
            const current = mode === 'month' ? sameDay(date, today) : mode === 'year' ? date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() : date.getFullYear() === today.getFullYear();
            const outside = mode === 'month' ? date.getMonth() !== display.getMonth() : mode === 'year' ? date.getFullYear() !== display.getFullYear() : Math.floor(date.getFullYear() / 10) !== Math.floor(display.getFullYear() / 10);
            const label = mode === 'month' ? String(date.getDate()) + (current ? t('common.dateTime.todaySuffix') : '') : mode === 'year' ? date.toLocaleDateString(locale, { month: 'long' }) : String(date.getFullYear());
            return <button aria-label={label} aria-selected={mode === 'month' ? selected : undefined} className={mode === 'month' ? 'floway-calendar-item floway-calendar-day' : 'floway-calendar-item floway-calendar-large-item'} data-current={current || undefined} data-outside={outside || undefined} data-selected={selected || undefined} disabled={unit < minimum || unit > maximum} key={unit} onClick={() => { setFocused(unit); onFocusDate(date); onSelect(date); }} onFocus={() => onFocusDate(date)} onKeyDown={event => keyDown(event, unit)} ref={unit === focused ? focusedRef : undefined} role="gridcell" style={mode === 'month' ? undefined : { '--floway-calendar-item-diameter': `${Math.min(294 / columns - 18, rowSize - 18)  }px` } as CSSProperties} tabIndex={unit === focused ? 0 : -1} type="button"><span>{mode === 'month' ? date.getDate() : mode === 'year' ? date.toLocaleDateString(locale, { month: 'short' }) : date.getFullYear()}</span></button>;
          })}
        </div>;
      })}
    </div>
  </div>;
}

export function CalendarView({ accentHeader = false, autoFocus = false, onSelectDate, value, minDate, maxDate }: { accentHeader?: boolean; autoFocus?: boolean; onSelectDate: (date: Date) => void; value: Date; minDate: Date; maxDate: Date }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [mode, setMode] = useState<Mode>('month');
  const [display, setDisplay] = useState(dateAt(value.getFullYear(), value.getMonth()));
  const [navigation, setNavigation] = useState({ serial: 0, date: value, focus: false });
  const [viewport, setViewport] = useState<Viewport>({ first: value.getTime(), before: true, after: true, rows: 6, columns: 7 });
  const onViewport = useCallback((next: Viewport) => setViewport(current => current.first === next.first && current.before === next.before && current.after === next.after && current.rows === next.rows && current.columns === next.columns ? current : next), []);
  const [previousMode, setPreviousMode] = useState<Mode | null>(null);
  const lastFocused = useRef(value);
  const headerRef = useRef<HTMLButtonElement>(null);
  const incomingRef = useRef<HTMLDivElement>(null);
  const outgoingRef = useRef<HTMLDivElement>(null);
  const backgroundRef = useRef<HTMLDivElement>(null);
  const snapshot = useRef<HTMLDivElement | null>(null);
  // Native shortest weekday names are Su in English and 日 in Simplified Chinese.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/test/native/external/enterprise/CalendarView/CalendarViewIntegrationTests.cpp#L2743-L2759
  const weekdays = Array.from({ length: 7 }, (_, index) => new Date(2026, 1, 1 + index));
  const year = display.getFullYear();
  const decade = year - year % 10;
  const header = mode === 'month' ? display.toLocaleDateString(locale, { month: 'long', year: 'numeric' }) : mode === 'year' ? String(year) : `${String(decade)  }–${  String(decade + 9)}`;

  useLayoutEffect(() => { if (autoFocus) headerRef.current?.focus({ preventScroll: true }); }, [autoFocus]);
  const lastHeader = useRef(header);
  useLayoutEffect(() => {
    if (lastHeader.current === header) return;
    lastHeader.current = header;
    if (reduceMotion()) return;
    const animation = headerRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: CALENDAR_HEADER_FADE_MS, easing: 'linear' });
    return () => animation?.cancel();
  }, [header]);

  useLayoutEffect(() => {
    if (previousMode === null) return;
    const incoming = incomingRef.current;
    const outgoing = outgoingRef.current;
    const background = backgroundRef.current;
    if (!incoming || !outgoing || !background || !snapshot.current) throw new Error('Calendar drill surfaces must be mounted together');
    outgoing.replaceChildren(snapshot.current);
    const oldScroll = outgoing.querySelector<HTMLElement>('.floway-calendar-scroll');
    if (oldScroll) oldScroll.scrollTop = Number(snapshot.current.dataset.scrollTop);
    const expanding = modes.indexOf(mode) > modes.indexOf(previousMode);
    const timing = { easing: CONTROL_FAST_OUT_SLOW_IN_EASING, fill: 'both' as const };
    const animations = [
      outgoing.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: expanding ? 'scale(0.84)' : 'scale(1.29)' }], { ...timing, duration: CALENDAR_DRILL_OUT_MS }),
      incoming.animate([{ opacity: 0, transform: expanding ? 'scale(1.29)' : 'scale(0.84)' }, { opacity: 1, transform: 'scale(1)' }], { ...timing, delay: CALENDAR_DRILL_OUT_MS, duration: CALENDAR_DRILL_IN_MS }),
      background.animate([{ opacity: 0 }, { opacity: 1 }], { ...timing, delay: 200, duration: 300 }),
    ];
    if (!expanding) animations.push(background.animate([{ transform: 'scale(0.84)' }, { transform: 'scale(1)' }], { ...timing, delay: CALENDAR_DRILL_OUT_MS, duration: CALENDAR_DRILL_IN_MS }));
    animations[1].addEventListener('finish', () => setPreviousMode(null), { once: true });
    return () => { for (const animation of animations) animation.cancel(); };
  }, [mode, previousMode]);

  const changeMode = (next: Mode, date = copyDate(next, display, lastFocused.current), focus = false) => {
    const current = incomingRef.current;
    if (!current) throw new Error('The current calendar view must be mounted');
    const clone = current.cloneNode(true) as HTMLDivElement;
    const scroll = current.querySelector<HTMLElement>('.floway-calendar-scroll');
    if (!scroll) throw new Error('The current calendar viewport must be mounted');
    clone.dataset.scrollTop = String(scroll.scrollTop);
    snapshot.current = clone;
    setPreviousMode(reduceMotion() ? null : mode);
    setMode(next);
    const focusDate = copyDate(mode, date, lastFocused.current);
    lastFocused.current = focusDate;
    setDisplay(date);
    setNavigation(current => ({ serial: current.serial + 1, date: focusDate, focus }));
  };
  const navigate = (amount: number) => {
    // Native arrows move by scope only when the viewport can show a whole scope.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/CalendarViewGeneratorHost.cpp#L429-L474
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/CalendarView_Partial.cpp#L2473-L2491
    const maximumScopeSize = mode === 'month' ? 31 : mode === 'year' ? 13 : 10;
    const fitsScope = (viewport.rows - 1) * viewport.columns + 1 >= maximumScopeSize;
    const first = new Date(viewport.first);
    let next: Date;
    if (fitsScope) {
      const scope = Math.max(unitOf(mode, minDate), scopeStart(mode, display));
      const delta = amount > 0 ? 1 : scope >= unitOf(mode, first) ? -1 : 0;
      next = dateOf(mode, scope);
      if (delta !== 0) {
        if (mode === 'month') next = dateAt(next.getFullYear(), next.getMonth() + delta);
        else next = dateAt(next.getFullYear() + delta * (mode === 'year' ? 1 : 10));
      }
    } else next = dateOf(mode, unitOf(mode, first) + amount * viewport.rows * viewport.columns);
    next = new Date(Math.max(minDate.getTime(), Math.min(maxDate.getTime(), next.getTime())));
    setNavigation(current => ({ serial: current.serial + 1, date: next, focus: false }));
  };
  const select = (date: Date) => {
    if (mode !== 'month') { changeMode(mode === 'year' ? 'month' : 'year', date, true); return; }
    onSelectDate(date);
  };
  const weekdayRow = <div className="floway-calendar-weekdays" role="row">{weekdays.map((day, index) => <span aria-label={day.toLocaleDateString(locale, { weekday: 'long' })} key={index} role="columnheader">{day.toLocaleDateString(locale, { weekday: locale.startsWith('zh') ? 'narrow' : 'short' }).slice(0, 2)}</span>)}</div>;
  return <div className="floway-calendar" data-accent-header={accentHeader || undefined}>
    <div className="floway-calendar-header">
      <button aria-label={t(mode === 'month' ? 'common.dateTime.previousMonth' : mode === 'year' ? 'common.dateTime.previousYear' : 'common.dateTime.previousDecade')} className="floway-calendar-navigation floway-calendar-previous" disabled={!viewport.before} onClick={() => navigate(-1)} type="button"><span><CalendarChevron direction="left" /></span></button>
      <button aria-label={t(mode === 'month' ? 'common.dateTime.chooseMonth' : 'common.dateTime.chooseYear').replace('{0}', header)} className="floway-calendar-heading" disabled={mode === 'decade'} onClick={() => changeMode(modes[modes.indexOf(mode) + 1])} ref={headerRef} type="button">{header}</button>
      <button aria-label={t(mode === 'month' ? 'common.dateTime.nextMonth' : mode === 'year' ? 'common.dateTime.nextYear' : 'common.dateTime.nextDecade')} className="floway-calendar-navigation floway-calendar-next" disabled={!viewport.after} onClick={() => navigate(1)} type="button"><span><CalendarChevron direction="right" /></span></button>
    </div>
    <div className="floway-calendar-top-border" />
    <div className="floway-calendar-views">
      <div aria-hidden="true" className="floway-calendar-measure" inert>{weekdayRow}<div className="floway-calendar-month-measure" /></div>
      <div className="floway-calendar-background" ref={backgroundRef} />
      {previousMode && <div aria-hidden="true" className="floway-calendar-view floway-calendar-outgoing" inert ref={outgoingRef} />}
      <div className="floway-calendar-view" ref={incomingRef} role="grid" aria-label={t('common.dateTime.date')}>
        {mode === 'month' && weekdayRow}
        <CalendarPanel display={display} key={mode} maxDate={maxDate} minDate={minDate} mode={mode} navigation={navigation} getFocusedDate={() => lastFocused.current} onFocusDate={date => { lastFocused.current = copyDate(mode, date, lastFocused.current); }} onDrillUp={date => { if (mode !== 'decade') changeMode(modes[modes.indexOf(mode) + 1], date, true); }} onScope={setDisplay} onViewport={onViewport} onSelect={select} value={value} />
      </div>
    </div>
  </div>;
}
