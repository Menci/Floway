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
      expect(resolveUsageMetricDisplayName('up-1', metricKey, metadata, t)).toMatchObject({ name: key, unit: 'percent', windowMinutes: null });
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

it('keeps metric choices stable across locale changes and separates distinct measurement units', async () => {
  const percentKey = JSON.stringify(['window', 'last_4_weeks']);
  const usdKey = JSON.stringify(['activity_cost', 'last_4_weeks']);
  const metadata = new Map([
    [JSON.stringify(['up-1', percentKey]), record(percentKey, 'ollama')],
    [JSON.stringify(['up-1', usdKey]), record(usdKey, 'ollama')],
  ]);
  const english = resolveUsageMetricDisplayName('up-1', percentKey, metadata, t);
  await setLanguage('zh-Hans');
  const chinese = resolveUsageMetricDisplayName('up-1', percentKey, metadata, t);
  expect(chinese.name).not.toBe(english.name);
  expect(chinese.metricId).toBe(english.metricId);
  expect(resolveUsageMetricDisplayName('up-1', usdKey, metadata, t).metricId).not.toBe(english.metricId);
});

it('compares equal fixed and encoded windows across providers under one metric choice', async () => {
  for (const language of ['en', 'zh-Hans'] as const) {
    await setLanguage(language);
    for (const [fixedKey, minutes] of [['five_hour', 300], ['seven_day', 10080]] as const) {
      const encodedKey = JSON.stringify(['window', '', minutes]);
      const metadata = new Map([
        [JSON.stringify(['up-1', fixedKey]), record(fixedKey, 'claude-code')],
        [JSON.stringify(['up-1', encodedKey]), record(encodedKey, 'codex')],
      ]);
      const fixed = resolveUsageMetricDisplayName('up-1', fixedKey, metadata, t);
      const encoded = resolveUsageMetricDisplayName('up-1', encodedKey, metadata, t);
      expect(fixed.name).toBe(encoded.name);
      expect(fixed.metricId).toBe(encoded.metricId);
    }
  }
});
