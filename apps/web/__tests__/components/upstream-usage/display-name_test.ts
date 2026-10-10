import { expect, it } from 'vitest';

import { resolveUsageMetricDisplayName } from '../../../src/components/upstream-usage/display-name';
import { i18n } from '../../../src/i18n';
import type { TFunction } from '../../../src/i18n/translation';
import type { UpstreamUsageMetricRecord } from '@floway-dev/gateway/browser';

const t = i18n.t.bind(i18n) as unknown as TFunction;
const record = (key: string, provider: UpstreamUsageMetricRecord['provider']): UpstreamUsageMetricRecord => ({ upstreamId: 'up-1', key, provider, timestamp: 1_000, value: 20, upstreamName: 'Seat', upstreamHue: 210 });

it('renders arbitrary metric names independently of JavaScript object prototypes', () => {
  for (const key of ['constructor', '__proto__', 'toString', 'future_metric']) {
    for (const [metricKey, provider] of [[key, 'copilot'], [JSON.stringify(['window', key]), 'ollama']] as const) {
      const metadata = new Map([[JSON.stringify(['up-1', metricKey]), record(metricKey, provider)]]);
      expect(resolveUsageMetricDisplayName('up-1', metricKey, metadata, t)).toEqual({ name: key, unit: 'percent', windowMinutes: null });
    }
  }
});

it('decodes each metric with its recorded provider after an upstream configuration is replaced', () => {
  const metadata = new Map([
    [JSON.stringify(['up-1', 'credits_balance']), record('credits_balance', 'codex')],
    [JSON.stringify(['up-1', 'premium_interactions']), record('premium_interactions', 'copilot')],
  ]);
  expect(resolveUsageMetricDisplayName('up-1', 'credits_balance', metadata, t).unit).toBe('credits');
  expect(resolveUsageMetricDisplayName('up-1', 'premium_interactions', metadata, t).unit).toBe('percent');
});
