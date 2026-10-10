import { expect, it } from 'vitest';

import { ollamaUsageMetrics, resolveUsageMetricDisplayName } from '../src/usage-metrics.ts';

it('records Ollama dynamic window percentages and hidden dollar cost, including zero', () => {
  const observation = { limits: { session: { usage: 0.25 }, weekly: { usage: 0.5 }, future: { usage: 0.1 } }, activity: { cost: '0.00000', period: { type: 'last_4_weeks', starting_at: '2026-10-01', ending_at: '2026-10-29' } } };
  const costKey = JSON.stringify(['activity_cost', 'last_4_weeks']);
  expect(ollamaUsageMetrics(observation)).toEqual(new Map([[JSON.stringify(['window', 'session']), 25], [JSON.stringify(['window', 'weekly']), 50], [JSON.stringify(['window', 'future']), 10], [costKey, 0]]));
  expect(resolveUsageMetricDisplayName(costKey)).toEqual({ name: 'last_4_weeks', unit: 'usd', windowMinutes: null });
  expect(ollamaUsageMetrics({ ...observation, activity: { cost: '12.34567', period: { type: 'last_4_weeks' } } }).get(costKey)).toBe(12.34567);
});

it('exposes malformed recognized costs and delivers nonfinite numeric usage to recording', () => {
  for (const cost of ['   ', 'invalid', true, null]) {
    expect(() => ollamaUsageMetrics({ activity: { cost, period: { type: 'last_4_weeks' } } })).toThrow(TypeError);
  }
  const body = JSON.parse('{"limits":{"session":{"usage":1e400}}}') as Record<string, unknown>;
  expect(ollamaUsageMetrics(body).get(JSON.stringify(['window', 'session']))).toBe(Infinity);
});
