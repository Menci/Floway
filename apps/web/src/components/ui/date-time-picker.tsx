import { useMemo } from 'react';

import { CalendarView } from './calendar-view';
import { Clock } from './clock';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { useLocale } from '../../lib/use-locale';

const { Link, Popover, PopoverSurface, PopoverTrigger, makeStyles } = fluentComponents;
const useStyles = makeStyles({ trigger: { fontSize: 'inherit', lineHeight: 'inherit', whiteSpace: 'nowrap' } });
// Reference defaults; callers own their data's available calendar bounds.
// https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Controls/Native/Date/DateTimeBase.cs#L75-L85
const DEFAULT_MIN = Date.UTC(1924, 0, 1);
const DEFAULT_MAX = Date.UTC(2124, 11, 31);

const dateOnDay = (day: Date, value: number, stepMs: number): number => {
  const current = new Date(value);
  if (day.getFullYear() === current.getFullYear() && day.getMonth() === current.getMonth() && day.getDate() === current.getDate()) return value;
  const selected = new Date(value);
  selected.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
  selected.setHours(current.getHours(), current.getMinutes(), 0, 0);
  return Math.ceil(selected.getTime() / stepMs) * stepMs;
};

export function DateTimePicker({
  label, min = DEFAULT_MIN, max = DEFAULT_MAX, timeSurfaceRef, onChange, onOpenChange, open, stepMs, surfaceRef, value,
}: {
  label: string;
  min?: number;
  max?: number;
  timeSurfaceRef: (element: HTMLDivElement | null) => void;
  stepMs: number;
  onChange: (value: number) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  surfaceRef: (element: HTMLDivElement | null) => void;
  value: number;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const styles = useStyles();
  const date = new Date(value);
  const calendarDayStart = new Date(value).setHours(0, 0, 0, 0);
  const timeFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), [locale]);
  const times = useMemo(() => {
    const start = new Date(calendarDayStart);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const result: number[] = [];
    for (let ms = Math.ceil(start.getTime() / stepMs) * stepMs; ms < end.getTime(); ms += stepMs) result.push(ms);
    return result;
  }, [calendarDayStart, stepMs]);
  const labelText = `${date.toLocaleDateString(locale, locale.startsWith('zh') ? { year: 'numeric', month: '2-digit', day: '2-digit' } : { year: 'numeric', month: 'short', day: 'numeric' })  } ${  timeFormatter.format(date)}`;
  return <Popover open={open} onOpenChange={(_, data) => onOpenChange(data.open)} positioning={{ position: 'below', align: 'center', fallbackPositions: ['above'] }}>
    <PopoverTrigger disableButtonEnhancement><Link aria-label={label} className={styles.trigger}>{labelText}</Link></PopoverTrigger>
    <PopoverSurface aria-label={label} className="floway-date-time-picker-surface" ref={surfaceRef}>
      <div className="floway-date-time-picker-body">
        <CalendarView accentHeader autoFocus maxDate={new Date(max)} minDate={new Date(min)} onSelectDate={day => onChange(dateOnDay(day, value, stepMs))} value={date} />
        <Clock active={open} label={`${label}: ${t('common.dateTime.time')}`} onChange={onChange} surfaceRef={timeSurfaceRef} value={value} values={times} />
      </div>
    </PopoverSurface>
  </Popover>;
}
