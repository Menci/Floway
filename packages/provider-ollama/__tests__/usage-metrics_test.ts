import { expect, test } from 'vitest';

import { ollamaUsageMetrics, resolveUsageMetricDisplayName } from '../src/usage-metrics.ts';

test('Ollama balance and historical utilization share window keys and preserve distinct money gauges', () => {
  const history = ollamaUsageMetrics({ limits: { session: { usage: 0.25 } }, activity: { cost: '3.50', period: { type: 'last_4_weeks' } } });
  const balance = ollamaUsageMetrics({ included: { session: { remaining_percent: 75 } }, purchased: { balance_usd: 25 } });
  expect(balance.get('["window","session"]')).toBe(history.get('["window","session"]'));
  expect(balance.get('["balance","purchased"]')).toBe(25);
  expect(history.get('["activity_cost","last_4_weeks"]')).toBe(3.5);
  expect(resolveUsageMetricDisplayName('["balance","purchased"]')).toEqual({ name: 'purchased', unit: 'usd', windowMinutes: null });
});

test('Ollama credit plan gauges do not manufacture percentage windows', () => {
  expect([...ollamaUsageMetrics({ included: { balance_usd: 72.5, allowance_usd: 100 }, purchased: { balance_usd: 0 } })]).toEqual([
    ['["balance","included"]', 72.5], ['["balance","purchased"]', 0],
  ]);
});

test('Ollama current activity totals retain their self-contained range', () => {
  const metrics = ollamaUsageMetrics({ range: '24h', totals: { request_count: 15, usage_usd: 0.01718 } });
  expect([...metrics]).toEqual([['["activity_cost","24h"]', 0.01718]]);
  expect(resolveUsageMetricDisplayName('["activity_cost","24h"]')).toEqual({ name: '24h', unit: 'usd', windowMinutes: null });
  expect(ollamaUsageMetrics({ range: '7d', totals: { request_count: 15 } }).size).toBe(0);
});
