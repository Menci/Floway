export interface CalendarDateRange { start: string; end: string }

export const calendarDate = (date: Date): string => `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export const parseCalendarDate = (value: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('Calendar dates must use YYYY-MM-DD');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  if (calendarDate(date) !== value) throw new RangeError('Invalid calendar date');
  return date;
};

export const nextCalendarDate = (value: string): string => {
  const date = parseCalendarDate(value);
  date.setDate(date.getDate() + 1);
  return calendarDate(date);
};

export const validateCalendarRange = ({ start, end }: CalendarDateRange): void => {
  parseCalendarDate(start);
  parseCalendarDate(end);
  if (start > end) throw new RangeError('The end date must not precede the start date');
};
