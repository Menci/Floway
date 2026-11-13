import { getExternalResourceFetcher, type ExternalResourceFetcher } from '@floway-dev/platform';
import { priceRequest, PricingHolidayCalendarRequiredError, type ModelPricing, type PricedRequest, type PricingHolidayCalendar, type PricingRuntimeFacts } from '@floway-dev/protocols/common';

type HolidayResolver = (calendar: PricingHolidayCalendar, date: string) => Promise<boolean>;

// This maintained dataset extracts State Council notices and links the original
// papers. It includes rest days and make-up workdays; only isOffDay=true is a
// holiday. Weekends remain a separate pricing condition, never a workday rule.
// https://github.com/NateScarlet/holiday-cn#readme
const source = (year: number): URL => new URL(`https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`);

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const parseCalendar = (value: unknown, year: number): ReadonlyMap<string, boolean> => {
  if (!record(value) || value.year !== year || !Array.isArray(value.papers) || value.papers.length === 0 || !value.papers.every(paper => typeof paper === 'string' && /^https?:\/\/(?:[\w-]+\.)*gov\.cn\//.test(paper)) || !Array.isArray(value.days) || value.days.length === 0) {
    throw new Error(`Holiday calendar CN ${year} has no published government notice or is malformed`);
  }
  const days = new Map<string, boolean>();
  for (const day of value.days) {
    if (!record(day) || typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Number.isFinite(Date.parse(`${day.date}T00:00:00Z`)) || new Date(`${day.date}T00:00:00Z`).toISOString().slice(0, 10) !== day.date || ![year - 1, year].includes(Number(day.date.slice(0, 4))) || typeof day.isOffDay !== 'boolean') {
      throw new Error(`Holiday calendar CN ${year} contains an invalid day`);
    }
    if (days.has(day.date) && days.get(day.date) !== day.isOffDay) throw new Error(`Holiday calendar CN ${year} has conflicting entries for ${day.date}`);
    days.set(day.date, day.isOffDay);
  }
  return days;
};

export const createPricingHolidayResolver = (
  fetcher: ExternalResourceFetcher,
  now: () => number = Date.now,
): HolidayResolver => {
  const cache = new Map<number, { expiresAt: number; pending: Promise<ReadonlyMap<string, boolean>> }>();
  const load = (year: number): Promise<ReadonlyMap<string, boolean>> => {
    const cached = cache.get(year);
    if (cached && cached.expiresAt > now()) return cached.pending;
    const entry = { expiresAt: Infinity, pending: Promise.resolve(new Map<string, boolean>() as ReadonlyMap<string, boolean>) };
    entry.pending = (async () => {
      try {
        const response = await fetcher(source(year), AbortSignal.timeout(5_000));
        if (!response.ok) throw new Error(`Holiday calendar CN ${year}: HTTP ${response.status}`);
        const text = await response.text();
        if (text.length > 65_536) throw new Error(`Holiday calendar CN ${year} exceeds the size limit`);
        const days = parseCalendar(JSON.parse(text), year);
        entry.expiresAt = now() + 24 * 60 * 60_000;
        return days;
      } catch (cause) {
        // Bound retries during an outage; never substitute an empty calendar.
        entry.expiresAt = now() + 60_000;
        throw new Error(`Failed to load holiday calendar CN ${year}`, { cause });
      }
    })();
    cache.delete(year);
    cache.set(year, entry);
    if (cache.size > 16) cache.delete(cache.keys().next().value!);
    return entry.pending;
  };
  return async (calendar, date) => {
    if (calendar !== 'CN') throw new Error(`Unsupported holiday calendar ${calendar as string}`);
    const year = Number(date.slice(0, 4));
    const current = await load(year);
    // A notice for the following year can change December dates. Do not
    // silently miss those changes when the next notice is not available yet.
    // https://github.com/NateScarlet/holiday-cn#注意事项
    const next = date.slice(5, 7) === '12' ? await load(year + 1) : undefined;
    return (next?.get(date) ?? current.get(date)) === true;
  };
};

const resolveHoliday = createPricingHolidayResolver((url, signal) => getExternalResourceFetcher()(url, signal));

export class PricingHolidayCalendarUnavailableError extends Error {
  constructor(calendar: PricingHolidayCalendar, date: string, cause: unknown) {
    super(`Cannot price request: holiday calendar ${calendar} is unavailable for ${date}`, { cause });
    this.name = 'PricingHolidayCalendarUnavailableError';
  }
}

export const priceRequestWithCalendars = async (
  pricing: ModelPricing | null,
  facts: PricingRuntimeFacts,
  resolve: HolidayResolver = resolveHoliday,
): Promise<PricedRequest> => {
  try {
    return priceRequest(pricing, facts);
  } catch (error) {
    if (!(error instanceof PricingHolidayCalendarRequiredError)) throw error;
    let isHoliday: boolean;
    try {
      isHoliday = await resolve(error.calendar, error.date);
    } catch (cause) {
      throw new PricingHolidayCalendarUnavailableError(error.calendar, error.date, cause);
    }
    return priceRequest(pricing, { ...facts, holidays: { [error.calendar]: { date: error.date, isHoliday } } });
  }
};
