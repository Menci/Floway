import { afterEach, expect, it } from 'vitest';

import type { UpstreamUsageMetadata } from '../../../src/components/upstream-usage/data';
import { resolveUsageMetricDisplayName } from '../../../src/components/upstream-usage/display-name';
import { i18n, setLanguage } from '../../../src/i18n';
import type { TFunction } from '../../../src/i18n/translation';

const t = i18n.t.bind(i18n) as unknown as TFunction;
const upstream = (kind: UpstreamUsageMetadata['kind'], id = 'up-1'): UpstreamUsageMetadata => ({ id, kind, name: 'Seat', hue: 210 });
afterEach(() => setLanguage('en'));

it('renders arbitrary metric names independently of JavaScript object prototypes', () => {
  for (const key of ['constructor', '__proto__', 'toString', 'future_metric']) {
    for (const [metricKey, kind] of [[key, 'copilot'], [JSON.stringify(['window', key]), 'ollama']] as const) {
      const metadata = new Map([['up-1', upstream(kind)]]);
      expect(resolveUsageMetricDisplayName('up-1', metricKey, metadata, t)).toMatchObject({ name: key, unit: 'percent', windowMinutes: null });
    }
  }
});

it('selects each provider decoder from current upstream metadata by ID', () => {
  const metadata = new Map([['up-1', upstream('codex')], ['up-2', upstream('copilot', 'up-2')]]);
  expect(resolveUsageMetricDisplayName('up-1', 'credits_balance', metadata, t).unit).toBe('credits');
  expect(resolveUsageMetricDisplayName('up-2', 'premium_interactions', metadata, t).unit).toBe('percent');
});

it('renders whole days and hours without a redundant default Codex limit name', async () => {
  for (const [language, labels] of [
    ['en', ['7-day window', '5-hour window', '90-minute window']],
    ['zh-Hans', ['7 天窗口', '5 小时窗口', '90 分钟窗口']],
  ] as const) {
    await setLanguage(language);
    const translate = i18n.getFixedT(language) as unknown as TFunction;
    for (const [index, minutes] of [10080, 300, 90].entries()) {
      for (const name of ['', 'codex', 'review']) {
        const key = JSON.stringify(['window', name, minutes]);
        const metadata = new Map([['up-1', upstream('codex')]]);
        expect(resolveUsageMetricDisplayName('up-1', key, metadata, translate).name).toBe(name === 'review' ? `review ${labels[index]}` : labels[index]);
      }
    }
  }
});

it('keeps metric choices stable across locales and gives costs their own metric name', async () => {
  const percentKey = JSON.stringify(['window', 'last_4_weeks']);
  const usdKey = JSON.stringify(['activity_cost', 'last_4_weeks']);
  const metadata = new Map([['up-1', upstream('ollama')]]);
  const english = resolveUsageMetricDisplayName('up-1', percentKey, metadata, t);
  expect(english.name).toBe('Past month');
  expect(resolveUsageMetricDisplayName('up-1', usdKey, metadata, t).name).toBe('Past month cost');
  await setLanguage('zh-Hans');
  const chinese = resolveUsageMetricDisplayName('up-1', percentKey, metadata, t);
  expect(chinese.name).toBe('最近一个月');
  expect(chinese.metricId).toBe(english.metricId);
  expect(resolveUsageMetricDisplayName('up-1', usdKey, metadata, t).metricId).not.toBe(english.metricId);
});

it('compares equal fixed and encoded windows across providers under one metric choice', async () => {
  for (const language of ['en', 'zh-Hans'] as const) {
    await setLanguage(language);
    for (const [fixedKey, minutes] of [['five_hour', 300], ['seven_day', 10080]] as const) {
      const encodedKey = JSON.stringify(['window', 'codex', minutes]);
      const metadata = new Map([['up-1', upstream('claude-code')], ['up-2', upstream('codex', 'up-2')]]);
      const fixed = resolveUsageMetricDisplayName('up-1', fixedKey, metadata, t);
      const encoded = resolveUsageMetricDisplayName('up-2', encodedKey, metadata, t);
      expect(fixed.name).toBe(encoded.name);
      expect(fixed.metricId).toBe(encoded.metricId);
    }
  }
});
