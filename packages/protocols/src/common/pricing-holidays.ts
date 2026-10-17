export type PricingHolidayCalendar = 'CN';

export type PricingHolidayFacts = Readonly<Partial<Record<PricingHolidayCalendar, {
  readonly date: string;
  readonly isHoliday: boolean;
}>>>;

// Holiday dates follow the calendar's jurisdiction, independently of the
// time window's clock. China's official notices use mainland civil dates.
// https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
const chinaDate = new Intl.DateTimeFormat('en', {
  timeZone: 'Asia/Shanghai', calendar: 'iso8601', numberingSystem: 'latn',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

export const pricingHolidayDate = (timestamp: number): string => {
  const parts = Object.fromEntries(chinaDate.formatToParts(timestamp).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export class PricingHolidayCalendarRequiredError extends Error {
  constructor(readonly calendar: PricingHolidayCalendar, readonly date: string) {
    super(`Pricing requires holiday calendar ${calendar} for ${date}`);
    this.name = 'PricingHolidayCalendarRequiredError';
  }
}
