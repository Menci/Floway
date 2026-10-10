import { afterEach, expect, it } from 'vitest';

import { resolveUsageMetricDisplayName } from '../../../src/components/upstream-usage/display-name';
import { i18n, setLanguage } from '../../../src/i18n';
import type { TFunction } from '../../../src/i18n/translation';
import type { UpstreamUsageMetricRecord } from '@floway-dev/gateway/browser';

const t = i18n.t.bind(i18n) as unknown as TFunction;
const record = (key: string, provider: UpstreamUsageMetricRecord['provider']): UpstreamUsageMetricRecord => ({ upstreamId: 'up-1', key, provider, timestamp: 1_000, value: 20, upstreamName: 'Seat', upstreamHue: 210 });
afterEach(() => setLanguage('en'));

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

it('renders whole-day and whole-hour windows while retaining exact minute durations', async () => {
  for (const [language, labels] of [
    ['en', ['7-day window', '5-hour window', '90-minute window']],
    ['zh-Hans', ['7 天窗口', '5 小时窗口', '90 分钟窗口']],
  ] as const) {
    await setLanguage(language);
    const translate = i18n.getFixedT(language) as unknown as TFunction;
    for (const [index, minutes] of [10080, 300, 90].entries()) {
      for (const name of ['', 'codex']) {
        const key = JSON.stringify(['window', name, minutes]);
        const metadata = new Map([[JSON.stringify(['up-1', key]), record(key, 'codex')]]);
        expect(resolveUsageMetricDisplayName('up-1', key, metadata, translate).name).toBe(name === '' ? labels[index] : `codex ${labels[index]}`);
      }
    }
  }
});
