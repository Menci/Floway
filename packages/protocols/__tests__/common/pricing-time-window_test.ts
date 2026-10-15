import { expect, test } from 'vitest';

import { canonicalizePricingSelector, modelPricing, parsePricingSelectorKey, canonicalPricingSelectorKey, priceRequest, pricingEntry, type PricingTimeWindowCoordinate } from '../../src/common/pricing.ts';

// DeepSeek's current peak windows; holidays are operator-maintained calendar dates.
// https://api-docs.deepseek.com/quick_start/pricing/
const morning: PricingTimeWindowCoordinate = { timeZone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '12:00', excludedDates: ['2026-10-01'] };
const afternoon = { ...morning, start: '14:00', end: '18:00' };
const pricing = modelPricing(
  pricingEntry({ input_tokens: '1', input_cache_read_tokens: '0.1', output_tokens: '3' }),
  pricingEntry({ input_tokens: '2', input_cache_read_tokens: '0.2', output_tokens: '6' }, { timeWindow: morning }),
  pricingEntry({ input_tokens: '2', input_cache_read_tokens: '0.2', output_tokens: '6' }, { timeWindow: afternoon }),
);

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
  const result = priceRequest(pricing, { requestStartedAt: Date.parse(instant) });
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
  ]) expect(priceRequest(catalog, { requestStartedAt: Date.parse(instant) }).rates?.input_tokens).toBe(expected);
});

test('resolves daylight saving using the configured zone, independent of the host zone', () => {
  const catalog = modelPricing(
    pricingEntry({ input_tokens: '1' }),
    pricingEntry({ input_tokens: '2' }, { timeWindow: { ...morning, timeZone: 'America/New_York' } }),
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
  const facts = { serviceTier: 'priority', requestStartedAt: Date.parse('2026-10-16T01:00:00Z') };
  expect(priceRequest(catalog, { ...facts, inputTokens: 100 }).rates?.input_tokens).toBe('3');
  expect(priceRequest(catalog, { ...facts, inputTokens: 101 }).rates?.input_tokens).toBe('4');
  expect(priceRequest(catalog, { ...facts, inputTokens: 101, requestStartedAt: Date.parse('2026-10-16T04:00:00Z') })).toEqual({ selector: {}, rates: { input_tokens: '1' } });
});

test.each([undefined, NaN, Infinity, 9e20])('rejects missing or invalid request time %s for scheduled pricing', requestStartedAt => {
  expect(() => priceRequest(pricing, { requestStartedAt })).toThrow(/requestStartedAt/);
});

test('canonical selectors round-trip through persisted JSON without array-order differences', () => {
  const selector = { timeWindow: { ...morning, weekdays: [5, 1, 2, 4, 3, 1], excludedDates: ['2026-10-02', '2026-10-01', '2026-10-01'] } };
  const canonical = canonicalizePricingSelector(selector);
  expect(canonical.timeWindow).toEqual({ ...morning, excludedDates: ['2026-10-01', '2026-10-02'] });
  expect(parsePricingSelectorKey(canonicalPricingSelectorKey(selector))).toEqual(canonical);
});

test.each([
  { timeZone: '' }, { timeZone: 'Invalid/Zone' }, { weekdays: [] }, { weekdays: [0] }, { weekdays: [8] }, { weekdays: [1.5] },
  { start: '9:00' }, { start: '24:00' }, { end: '12:60' }, { end: '08:00' }, { end: '09:00' },
  { excludedDates: ['2026-02-30'] }, { excludedDates: ['2026-1-1'] }, { excludedDates: null }, { extra: true },
])('rejects malformed time window %j', patch => {
  expect(() => canonicalizePricingSelector({ timeWindow: { ...morning, ...patch } } as never)).toThrow();
});

test('rejects ambiguous windows, including those with different finite holiday exclusions', () => {
  for (const window of [{ ...afternoon, start: '11:00' }, { ...morning, excludedDates: [] }, { ...afternoon, timeZone: 'UTC' }]) {
    expect(() => modelPricing(
      pricingEntry({ input_tokens: '1' }),
      pricingEntry({ input_tokens: '2' }, { timeWindow: morning }),
      pricingEntry({ input_tokens: '3' }, { timeWindow: window }),
    )).toThrow(/time windows/);
  }
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
