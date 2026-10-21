import { expect, test } from 'vitest';

import { canonicalizePricingSelector, modelPricing, parsePricingSelectorKey, canonicalPricingSelectorKey, priceRequest, pricingEntry, PricingHolidayCalendarRequiredError, type PricingTimeWindowCoordinate } from '../../src/common/pricing.ts';

// DeepSeek's current peak windows, with an automatically resolved holiday calendar.
// https://api-docs.deepseek.com/quick_start/pricing/
const morning: PricingTimeWindowCoordinate = { timeZone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '12:00', excludeHolidays: 'CN' };
const afternoon = { ...morning, start: '14:00', end: '18:00' };
const pricing = modelPricing(
  pricingEntry({ input_tokens: '1', input_cache_read_tokens: '0.1', output_tokens: '3' }),
  pricingEntry({ input_tokens: '2', input_cache_read_tokens: '0.2', output_tokens: '6' }, { timeWindow: morning }),
  pricingEntry({ input_tokens: '2', input_cache_read_tokens: '0.2', output_tokens: '6' }, { timeWindow: afternoon }),
);

const at = (instant: string) => ({
  requestStartedAt: Date.parse(instant),
  holidays: {
    CN: {
      date: new Date(Date.parse(instant) + 8 * 60 * 60_000).toISOString().slice(0, 10),
      isHoliday: instant === '2026-10-01T01:00:00Z' || instant === '2026-09-30T16:00:00Z',
    },
  },
});

test.each([
  ['2026-10-16T00:59:59.999Z', '1'],
  ['2026-10-16T01:00:00Z', '2'],
  ['2026-10-16T03:59:59.999Z', '2'],
  ['2026-10-16T04:00:00Z', '1'],
  ['2026-10-16T05:59:59.999Z', '1'],
  ['2026-10-16T06:00:00Z', '2'],
  ['2026-10-16T09:59:59.999Z', '2'],
  ['2026-10-16T10:00:00Z', '1'],
  ['2026-10-17T01:00:00Z', '1'],
  ['2026-10-18T06:00:00Z', '1'],
  ['2026-10-19T01:00:00Z', '2'],
  ['2026-10-01T01:00:00Z', '1'],
])('prices all token metrics at the request start %s', (instant, rate) => {
  const result = priceRequest(pricing, at(instant));
  expect(result.rates).toEqual(rate === '2'
    ? { input_tokens: '2', input_cache_read_tokens: '0.2', output_tokens: '6' }
    : { input_tokens: '1', input_cache_read_tokens: '0.1', output_tokens: '3' });
  expect(result.selector.timeWindow !== undefined).toBe(rate === '2');
});

test('uses local dates for weekday and holiday boundaries across UTC midnight', () => {
  const catalog = modelPricing(
    pricingEntry({ input_tokens: '1' }),
    pricingEntry({ input_tokens: '2' }, { timeWindow: { ...morning, start: '00:00', end: '24:00' } }),
  );
  for (const [instant, expected] of [
    ['2026-10-16T15:59:59.999Z', '2'], ['2026-10-16T16:00:00Z', '1'],
    ['2026-10-18T15:59:59.999Z', '1'], ['2026-10-18T16:00:00Z', '2'],
    ['2026-09-30T15:59:59.999Z', '2'], ['2026-09-30T16:00:00Z', '1'],
  ]) expect(priceRequest(catalog, at(instant)).rates?.input_tokens).toBe(expected);
});

test('resolves daylight saving using the configured zone, independent of the host zone', () => {
  const catalog = modelPricing(
    pricingEntry({ input_tokens: '1' }),
    pricingEntry({ input_tokens: '2' }, { timeWindow: { ...morning, timeZone: 'America/New_York', excludeHolidays: undefined } }),
  );
  expect(priceRequest(catalog, { requestStartedAt: Date.parse('2026-07-06T13:00:00Z') }).rates?.input_tokens).toBe('2');
  expect(priceRequest(catalog, { requestStartedAt: Date.parse('2026-01-05T13:00:00Z') }).rates?.input_tokens).toBe('1');
  expect(priceRequest(catalog, { requestStartedAt: Date.parse('2026-01-05T14:00:00Z') }).rates?.input_tokens).toBe('2');
});

test('combines time windows with service tiers and window-scoped input thresholds', () => {
  const catalog = modelPricing(
    pricingEntry({ input_tokens: '1' }),
    pricingEntry({ input_tokens: '2' }, { timeWindow: morning }),
    pricingEntry({ input_tokens: '3' }, { timeWindow: morning, serviceTier: 'priority' }),
    pricingEntry({ input_tokens: '4' }, { timeWindow: morning, serviceTier: 'priority', inputTokens: { operator: 'gt', value: 100 } }),
  );
  const facts = { serviceTier: 'priority', ...at('2026-10-16T01:00:00Z') };
  expect(priceRequest(catalog, { ...facts, inputTokens: 100 }).rates?.input_tokens).toBe('3');
  expect(priceRequest(catalog, { ...facts, inputTokens: 101 }).rates?.input_tokens).toBe('4');
  expect(priceRequest(catalog, { ...facts, inputTokens: 101, requestStartedAt: Date.parse('2026-10-16T04:00:00Z') })).toEqual({ selector: {}, rates: { input_tokens: '1' } });
});

test.each([undefined, NaN, Infinity, 9e20])('rejects missing or invalid request time %s for scheduled pricing', requestStartedAt => {
  expect(() => priceRequest(pricing, { requestStartedAt })).toThrow(/requestStartedAt/);
});

test('canonical selectors round-trip through persisted JSON without array-order differences', () => {
  const selector = { timeWindow: { ...morning, weekdays: [5, 1, 2, 4, 3, 1] } };
  const canonical = canonicalizePricingSelector(selector);
  expect(canonical.timeWindow).toEqual(morning);
  expect(parsePricingSelectorKey(canonicalPricingSelectorKey(selector))).toEqual(canonical);
});

test.each([
  { timeZone: '' }, { timeZone: 'Invalid/Zone' }, { weekdays: [] }, { weekdays: [0] }, { weekdays: [8] }, { weekdays: [1.5] },
  { start: '9:00' }, { start: '24:00' }, { end: '12:60' }, { end: '25:00' },
  { excludeHolidays: 'unknown' }, { excludeHolidays: null }, { extra: true },
])('rejects malformed time window %j', patch => {
  expect(() => canonicalizePricingSelector({ timeWindow: { ...morning, ...patch } } as never)).toThrow();
});

test('rejects ambiguous windows, including those with different holiday exclusions', () => {
  for (const window of [{ ...afternoon, start: '11:00' }, { ...morning, excludeHolidays: undefined }, { ...afternoon, timeZone: 'UTC' }]) {
    expect(() => modelPricing(
      pricingEntry({ input_tokens: '1' }),
      pricingEntry({ input_tokens: '2' }, { timeWindow: morning }),
      pricingEntry({ input_tokens: '3' }, { timeWindow: window }),
    )).toThrow(/time windows/);
  }
});

const scheduled = (window: PricingTimeWindowCoordinate) => modelPricing(
  pricingEntry({ input_tokens: '1' }), pricingEntry({ input_tokens: '2' }, { timeWindow: window }),
);

test('overnight weekdays refer to the request date rather than the start of the window', () => {
  const catalog = scheduled({ timeZone: 'UTC', weekdays: [5], start: '22:00', end: '02:00' });
  for (const [instant, rate] of [
    ['2026-10-16T00:00:00Z', '2'], ['2026-10-16T01:59:59.999Z', '2'], ['2026-10-16T02:00:00Z', '1'],
    ['2026-10-16T21:59:59.999Z', '1'], ['2026-10-16T22:00:00Z', '2'], ['2026-10-17T00:00:00Z', '1'],
  ]) expect(priceRequest(catalog, at(instant)).rates?.input_tokens).toBe(rate);
});

test('equal clock boundaries cover the entire selected day', () => {
  const catalog = scheduled({ timeZone: 'UTC', weekdays: [5], start: '09:00', end: '09:00' });
  for (const hour of ['00', '08', '09', '23']) expect(priceRequest(catalog, at(`2026-10-16T${hour}:00:00Z`)).rates?.input_tokens).toBe('2');
  expect(priceRequest(catalog, at('2026-10-17T00:00:00Z')).rates?.input_tokens).toBe('1');
});

test('detects overlap on both sides of midnight without rejecting adjacent windows', () => {
  const overnight = { timeZone: 'UTC', weekdays: [5], start: '22:00', end: '02:00' };
  for (const [start, end, overlaps] of [['01:00', '03:00', true], ['21:00', '23:00', true], ['02:00', '22:00', false], ['00:00', '00:00', true]] as const) {
    const create = () => modelPricing(...scheduled(overnight).entries,
      pricingEntry({ input_tokens: '3' }, { timeWindow: { ...overnight, start, end } }));
    if (overlaps) expect(create).toThrow(/overlap/);
    else expect(create).not.toThrow();
  }
});

test('a repeated DST hour matches twice and a skipped hour never matches', () => {
  const window = { timeZone: 'America/New_York', weekdays: [7], start: '01:30', end: '02:00' };
  const fall = scheduled(window);
  for (const instant of ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z']) expect(priceRequest(fall, at(instant)).rates?.input_tokens).toBe('2');
  expect(priceRequest(fall, at('2026-11-01T07:00:00Z')).rates?.input_tokens).toBe('1');
  const spring = scheduled({ ...window, start: '02:00', end: '03:00' });
  for (const instant of ['2026-03-08T06:59:59.999Z', '2026-03-08T07:00:00Z']) expect(priceRequest(spring, at(instant)).rates?.input_tokens).toBe('1');
});

test('holiday dates use the calendar jurisdiction even when the pricing clock uses UTC', () => {
  const catalog = scheduled({ timeZone: 'UTC', weekdays: [3, 4], start: '00:00', end: '24:00', excludeHolidays: 'CN' });
  expect(priceRequest(catalog, at('2026-09-30T15:59:59.999Z')).rates?.input_tokens).toBe('2');
  expect(priceRequest(catalog, at('2026-09-30T16:00:00Z')).rates?.input_tokens).toBe('1');
  expect(() => priceRequest(catalog, { requestStartedAt: Date.parse('2026-09-30T16:00:00Z'), holidays: { CN: { date: '2026-09-30', isHoliday: false } } })).toThrow(PricingHolidayCalendarRequiredError);
});

test('missing holiday facts are required only inside an applicable window', () => {
  expect(() => priceRequest(pricing, { requestStartedAt: Date.parse('2026-10-16T01:00:00Z') })).toThrow(PricingHolidayCalendarRequiredError);
  expect(priceRequest(pricing, { requestStartedAt: Date.parse('2026-10-17T01:00:00Z') }).rates?.input_tokens).toBe('1');
});

test('base service-tier spellings do not bypass scheduled rates or token thresholds', () => {
  const window = { timeZone: 'UTC', weekdays: [5], start: '12:00', end: '18:00' };
  const catalog = modelPricing(...scheduled(window).entries,
    pricingEntry({ input_tokens: '3' }, { timeWindow: window, inputTokens: { operator: 'gt', value: 100 } }));
  for (const serviceTier of [undefined, 'default', 'standard', ' Standard ', '']) {
    expect(priceRequest(catalog, { ...at('2026-10-16T12:00:00Z'), serviceTier, inputTokens: 100 }).rates?.input_tokens).toBe('2');
    expect(priceRequest(catalog, { ...at('2026-10-16T12:00:00Z'), serviceTier, inputTokens: 101 }).rates?.input_tokens).toBe('3');
  }
  expect(priceRequest(catalog, { ...at('2026-10-16T12:00:00Z'), serviceTier: 'unknown' })).toEqual({ selector: {}, rates: { input_tokens: '1' } });
});

test('unresolved pricing markers round-trip as usage state but cannot be authored as price rules', () => {
  const selector = { unpriced: 'holiday-calendar-unavailable' };
  expect(parsePricingSelectorKey(canonicalPricingSelectorKey(selector))).toEqual(selector);
  expect(() => canonicalizePricingSelector({ unpriced: 'unknown' })).toThrow(/unknown unpriced/);
  expect(() => modelPricing(pricingEntry({ input_tokens: '1' }), pricingEntry({ input_tokens: '2' }, selector))).toThrow(/reserved for usage/);
});

test('allows adjacent windows and overlapping windows in disjoint service tiers', () => {
  expect(() => modelPricing(
    pricingEntry({ input_tokens: '1' }),
    pricingEntry({ input_tokens: '2' }, { timeWindow: morning, serviceTier: 'fast' }),
    pricingEntry({ input_tokens: '3' }, { timeWindow: { ...morning, start: '11:00' }, serviceTier: 'flex' }),
    pricingEntry({ input_tokens: '4' }, { timeWindow: { ...morning, start: '12:00', end: '13:00' }, serviceTier: 'fast' }),
  )).not.toThrow();
});

test('preserves the authored time zone identifier in persistent selector keys', () => {
  const selector = { timeWindow: { ...morning, timeZone: 'Asia/Kolkata' } };
  expect(parsePricingSelectorKey(canonicalPricingSelectorKey(selector))).toEqual(selector);
});
