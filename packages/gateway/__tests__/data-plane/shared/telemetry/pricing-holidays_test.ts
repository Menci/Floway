import { expect, test, vi } from 'vitest';

import { createPricingHolidayResolver, priceRequestWithCalendars, PricingHolidayCalendarUnavailableError } from '../../../../src/data-plane/shared/telemetry/pricing-holidays.ts';
import { modelPricing, pricingEntry } from '@floway-dev/protocols/common';

// Representative days from the linked State Council notice, including a
// make-up Saturday. A make-up workday must not become a peak weekday.
const paper = 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm';
const calendar = {
  year: 2026, papers: [paper], days: [
    { date: '2026-10-01', isOffDay: true },
    { date: '2026-10-10', isOffDay: false },
  ],
};
const pricing = modelPricing(
  pricingEntry({ input_tokens: '1' }),
  pricingEntry({ input_tokens: '2' }, { timeWindow: { timeZone: 'UTC', weekdays: [1, 2, 3, 4, 5], start: '01:00', end: '04:00', excludeHolidays: 'CN' } }),
);
const at = (instant: string) => ({ requestStartedAt: Date.parse(instant) });

test('calendar data is fetched once for concurrent requests and refreshed after expiry', async () => {
  let now = 0;
  const fetcher = vi.fn(async () => Response.json(calendar));
  const resolve = createPricingHolidayResolver(fetcher, () => now);
  expect(await Promise.all([resolve('CN', '2026-10-01'), resolve('CN', '2026-10-02')])).toEqual([true, false]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toEqual([new URL('https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/2026.json'), expect.any(AbortSignal)]);
  now += 24 * 60 * 60_000;
  await resolve('CN', '2026-10-01');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('holidays select Base, normal weekdays select peak, and weekends need no calendar', async () => {
  const fetcher = vi.fn(async () => Response.json(calendar));
  const resolve = createPricingHolidayResolver(fetcher);
  expect((await priceRequestWithCalendars(pricing, at('2026-10-10T01:00:00Z'), resolve)).rates?.input_tokens).toBe('1');
  expect((await priceRequestWithCalendars(pricing, at('2026-10-16T05:00:00Z'), resolve)).rates?.input_tokens).toBe('1');
  expect(fetcher).not.toHaveBeenCalled();
  expect((await priceRequestWithCalendars(pricing, at('2026-10-01T01:00:00Z'), resolve)).rates?.input_tokens).toBe('1');
  expect((await priceRequestWithCalendars(pricing, at('2026-10-16T01:00:00Z'), resolve)).rates?.input_tokens).toBe('2');
  expect(await resolve('CN', '2026-10-10')).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each([
  { ...calendar, year: 2025 }, { ...calendar, papers: [] }, { ...calendar, days: [] },
  { ...calendar, papers: ['https://example.com/notice'] },
  { ...calendar, days: [{ date: '2026-02-30', isOffDay: true }] },
  { ...calendar, days: [{ date: '2026-10-01', isOffDay: 'true' }] },
  { ...calendar, days: [{ date: '2027-10-01', isOffDay: true }] },
  { ...calendar, days: [{ date: '2026-10-01', isOffDay: true }, { date: '2026-10-01', isOffDay: false }] },
])('rejects unpublished or malformed calendar data: %j', async data => {
  const resolve = createPricingHolidayResolver(async () => Response.json(data));
  await expect(priceRequestWithCalendars(pricing, at('2026-10-16T01:00:00Z'), resolve)).rejects.toBeInstanceOf(PricingHolidayCalendarUnavailableError);
});

test('HTTP failures, invalid JSON, and network errors retain their error chain and retry after backoff', async () => {
  const networkError = new Error('offline');
  let now = 0;
  const fetcher = vi.fn()
    .mockRejectedValueOnce(networkError)
    .mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockResolvedValueOnce(new Response('invalid json'))
    .mockResolvedValueOnce(Response.json(calendar));
  const resolve = createPricingHolidayResolver(fetcher, () => now);
  await expect(priceRequestWithCalendars(pricing, at('2026-10-16T01:00:00Z'), resolve)).rejects.toMatchObject({ cause: { cause: networkError } });
  await expect(resolve('CN', '2026-10-16')).rejects.toMatchObject({ cause: networkError });
  expect(fetcher).toHaveBeenCalledTimes(1);
  now += 60_000;
  await expect(resolve('CN', '2026-10-16')).rejects.toMatchObject({ cause: { message: 'Holiday calendar CN 2026: HTTP 404' } });
  now += 60_000;
  await expect(resolve('CN', '2026-10-16')).rejects.toMatchObject({ cause: expect.any(SyntaxError) });
  now += 60_000;
  expect(await resolve('CN', '2026-10-16')).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(4);
});

test('December includes changes published in the following year notice', async () => {
  const fetcher = vi.fn(async (url: URL) => Response.json(url.pathname.endsWith('/2026.json') ? calendar : {
    year: 2027, papers: [paper], days: [{ date: '2026-12-31', isOffDay: true }],
  }));
  const resolve = createPricingHolidayResolver(fetcher);
  expect(await resolve('CN', '2026-12-31')).toBe(true);
  expect(await resolve('CN', '2026-12-30')).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('a future year placeholder does not imply that December has no holidays', async () => {
  const resolve = createPricingHolidayResolver(async url => Response.json(url.pathname.endsWith('/2026.json') ? calendar : { year: 2027, papers: [], days: [] }));
  await expect(resolve('CN', '2026-12-31')).rejects.toThrow('Failed to load holiday calendar CN 2027');
});
