import type { CalendarStrings, DateFormatting } from '@fluentui/react-calendar-compat';
import { CaretDown12Filled, CaretUp12Filled } from '@fluentui/react-icons';
import { useMemo, useState } from 'react';

import { Dropdown, Input } from './fluent-form-controls';
import { ScrollArea } from './scroll-area';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { useLocale } from '../../lib/use-locale';

const { Button, Calendar, Field, Option, Popover, PopoverSurface, PopoverTrigger, makeStyles, tokens } = fluentComponents;
// CalendarView uses the solid up/down carets EDDB and EDDC.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CalendarView_themeresources.xaml#L682-L683
const calendarNavigationIcons = { upNavigation: <CaretUp12Filled />, downNavigation: <CaretDown12Filled /> };
const pad = (value: number) => String(value).padStart(2, '0');
const dateText = (value: number) => {
  const date = new Date(value);
  return `${String(date.getFullYear()).padStart(4, '0')}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
};

const useStyles = makeStyles({
  // An inline trigger takes the text leading; the popup retains full-size controls.
  trigger: {
    minHeight: `${tokens.lineHeightBase300} !important`,
    minWidth: '0 !important',
    padding: '0 !important',
    fontWeight: tokens.fontWeightRegular,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
    whiteSpace: 'nowrap',
    color: 'var(--winui-text-fill-secondary)',
  },
  surface: { maxWidth: 'calc(100vw - 2 * var(--spacingHorizontalL))' },
  body: {
    display: 'flex', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalM, alignItems: 'start',
  },
  calendar: { minWidth: '0', maxWidth: '100%', flexShrink: 1 },
  fields: { display: 'grid', rowGap: tokens.spacingVerticalM, minWidth: '0', flex: '1 0 var(--winui-combo-box-min-width)' },

});

const dateOnDay = (day: Date, value: number, stepMs: number): number => {
  const current = new Date(value);
  if (day.getFullYear() === current.getFullYear() && day.getMonth() === current.getMonth() && day.getDate() === current.getDate()) return value;
  const selected = new Date(value);
  selected.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
  selected.setHours(current.getHours(), current.getMinutes(), 0, 0);
  return Math.ceil(selected.getTime() / stepMs) * stepMs;
};

export function DateTimePicker({
  label, listboxRef, onChange, onOpenChange, onValidityChange, open, resetToken, stepMs, surfaceRef, value,
}: {
  label: string;
  listboxRef: (element: HTMLDivElement | null) => void;
  resetToken: number;
  stepMs: number;
  onChange: (value: number) => void;
  onOpenChange: (open: boolean) => void;
  onValidityChange: (valid: boolean) => void;
  open: boolean;
  surfaceRef: (element: HTMLDivElement | null) => void;
  value: number;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const styles = useStyles();
  const [input, setInput] = useState({ text: dateText(value), invalid: false, resetToken });
  const invalid = input.resetToken === resetToken && input.invalid;
  const text = invalid ? input.text : dateText(value);
  const date = new Date(value);
  const timeFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), [locale]);
  const calendarStrings = useMemo<CalendarStrings>(() => ({
    months: Array.from({ length: 12 }, (_, month) => new Date(2026, month, 1).toLocaleDateString(locale, { month: 'long' })),
    shortMonths: Array.from({ length: 12 }, (_, month) => new Date(2026, month, 1).toLocaleDateString(locale, { month: 'short' })),
    days: Array.from({ length: 7 }, (_, day) => new Date(2026, 1, 1 + day).toLocaleDateString(locale, { weekday: 'long' })),
    shortDays: Array.from({ length: 7 }, (_, day) => new Date(2026, 1, 1 + day).toLocaleDateString(locale, { weekday: 'narrow' })),
    goToToday: t('common.dateTime.today'),
    prevMonthAriaLabel: t('common.dateTime.previousMonth'), nextMonthAriaLabel: t('common.dateTime.nextMonth'),
    prevYearAriaLabel: t('common.dateTime.previousYear'), nextYearAriaLabel: t('common.dateTime.nextYear'),
    prevYearRangeAriaLabel: t('common.dateTime.previousDecade'), nextYearRangeAriaLabel: t('common.dateTime.nextDecade'),
    monthPickerHeaderAriaLabel: t('common.dateTime.chooseYear'), yearPickerHeaderAriaLabel: t('common.dateTime.chooseMonth'),
    closeButtonAriaLabel: t('common.dismiss'), weekNumberFormatString: t('common.dateTime.week'),
    selectedDateFormatString: t('common.dateTime.selectedDate'), todayDateFormatString: t('common.dateTime.todayDate'),
    dayMarkedAriaLabel: t('common.dateTime.markedDate'),
  }), [locale, t]);
  const dateFormatter = useMemo<DateFormatting>(() => ({
    formatDay: date => String(date.getDate()),
    formatMonth: date => date.toLocaleDateString(locale, { month: 'long' }),
    formatYear: date => String(date.getFullYear()),
    formatMonthDayYear: date => date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' }),
    formatMonthYear: date => date.toLocaleDateString(locale, { year: 'numeric', month: 'long' }),
  }), [locale]);
  const times = useMemo(() => {
    const start = new Date(value);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const result: number[] = [];
    for (let ms = Math.ceil(start.getTime() / stepMs) * stepMs; ms < end.getTime(); ms += stepMs) result.push(ms);
    return result;
  }, [stepMs, value]);
  const selectDate = (day: Date) => {
    const next = dateOnDay(day, value, stepMs);
    setInput({ text: dateText(next), invalid: false, resetToken });
    onValidityChange(true);
    onChange(next);
  };
  const changeText = (next: string) => {
    const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(next);
    const day = match === null ? null : new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00`);
    const valid = day !== null && dateText(day.getTime()) === next;
    setInput({ text: next, invalid: !valid, resetToken });
    onValidityChange(valid);
    if (valid && day) onChange(dateOnDay(day, value, stepMs));
  };
  const labelText = `${date.toLocaleDateString(locale, locale.startsWith('zh') ? { year: 'numeric', month: '2-digit', day: '2-digit' } : { year: 'numeric', month: 'short', day: 'numeric' })} ${timeFormatter.format(date)}`;
  return <Popover open={open} onOpenChange={(_, data) => onOpenChange(data.open)} positioning={{ position: 'below', align: 'end', fallbackPositions: ['above'] }}>
    <PopoverTrigger disableButtonEnhancement>
      <Button appearance="transparent" aria-label={label} className={styles.trigger}>{labelText}</Button>
    </PopoverTrigger>
    <PopoverSurface aria-label={label} className={styles.surface} ref={surfaceRef}>
      <div className={styles.body}>
        <ScrollArea axes="horizontal" className={styles.calendar}>
          <Calendar
            calendarDayProps={{ navigationIcons: calendarNavigationIcons }}
            calendarMonthProps={{ navigationIcons: calendarNavigationIcons }}
            dateTimeFormatter={dateFormatter}
            onDismiss={() => onOpenChange(false)}
            onSelectDate={selectDate}
            showGoToToday={false}
            showMonthPickerAsOverlay
            showSixWeeksByDefault
            strings={calendarStrings}
            value={date}
          />
        </ScrollArea>
        <div className={styles.fields}>
          <Field label={t('common.dateTime.date')} validationMessage={invalid ? t('common.dateTime.invalidDate') : undefined} validationState={invalid ? 'error' : 'none'}>
            <Input aria-label={`${label}: ${t('common.dateTime.date')}`} onChange={(_, data) => changeText(data.value)} placeholder={t('common.dateTime.dateFormat')} value={text} />
          </Field>
          <Field label={t('common.dateTime.time')}>
            <Dropdown listboxRef={listboxRef} aria-label={`${label}: ${t('common.dateTime.time')}`} onOptionSelect={(_, data) => onChange(Number(data.optionValue))} selectedOptions={[String(value)]} value={timeFormatter.format(date)}>
              {times.map(ms => <Option key={ms} value={String(ms)}>{timeFormatter.format(new Date(ms))}</Option>)}
            </Dropdown>
          </Field>
        </div>
      </div>
    </PopoverSurface>
  </Popover>;
}
