import { afterEach, expect, it } from 'vitest';

import type { UpstreamMetricsMetadata } from '../../../src/components/upstream-metrics/data';
import { resolveUpstreamMetricDisplays } from '../../../src/components/upstream-metrics/display-name';
import { i18n, setLanguage } from '../../../src/i18n';
import type { TFunction } from '../../../src/i18n/translation';
import { normalizeUpstreamMetricIdentity } from '@floway-dev/provider/browser';

const t = i18n.t.bind(i18n) as unknown as TFunction;
const upstream = (kind: UpstreamMetricsMetadata['kind'], id = 'up-1'): UpstreamMetricsMetadata => ({ id, kind, name: 'Seat', hue: 210 });
const displayOf = (
  kind: UpstreamMetricsMetadata['kind'],
  identity: { name: string; labels: Record<string, string | number | boolean | null> },
  quotaDisplay: 'remaining' | 'used' = 'remaining',
  translate: TFunction = t,
) => {
  const sample = { ...normalizeUpstreamMetricIdentity(identity.name, identity.labels), timestamp: 1_000, value: 25 };
  const samples = kind === 'copilot' && identity.name === 'quota.remaining'
    ? [sample, { name: 'quota.entitlement', labels: sample.labels, timestamp: 1_000, value: 100 }]
    : [sample];
  return resolveUpstreamMetricDisplays(upstream(kind), samples, translate, { quotaDisplay })[0]!.display;
};
afterEach(() => setLanguage('en'));

it('renders arbitrary label values independently of JavaScript object prototypes', () => {
  for (const quota of ['constructor', '__proto__', 'toString', 'future_metric']) {
    expect(displayOf('copilot', { name: 'quota.remaining', labels: { quota } })).toMatchObject({ name: `${quota} remaining`, unit: 'count', windowSeconds: null });
  }
});

it('selects each provider decoder from the current upstream', () => {
  expect(displayOf('codex', { name: 'credits.balance', labels: {} }).unit).toBe('credits');
  expect(displayOf('copilot', { name: 'quota.remaining', labels: { quota: 'premium_interactions' } }).unit).toBe('usd');
});

it('renders undecoded identities as unitless raw series', () => {
  for (const [kind, identity, name] of [
    ['copilot', { name: 'quota.overage', labels: { quota: 'chat "beta"', limit: 456, shared: true, scope: null } }, 'quota.overage{limit=456,quota="chat \\"beta\\"",scope=null,shared=true}'],
    ['claude-code', { name: 'quota.utilization', labels: { quota: 'five_hour', region: 'us' } }, 'quota.utilization{quota="five_hour",region="us"}'],
    ['azure', { name: 'tokens.remaining', labels: {} }, 'tokens.remaining'],
  ] as const) {
    const display = displayOf(kind, identity);
    expect(display).toMatchObject({ name, unit: 'none', windowSeconds: null, emptyValue: null, form: 'line' });
    expect(display.toDisplayValue(123.5)).toBe(123.5);
  }
});

it('names dynamic quota windows by direction', async () => {
  for (const [language, cases] of [
    ['en', [
      [604_800, '7-day remaining', '7-day usage', '7-day review remaining', '7-day review usage'],
      [18_000, '5-hour remaining', '5-hour usage', '5-hour review remaining', '5-hour review usage'],
      [5_400, '90-minute remaining', '90-minute usage', '90-minute review remaining', '90-minute review usage'],
      [125, '125-second remaining', '125-second usage', '125-second review remaining', '125-second review usage'],
    ]],
    ['zh-Hans', [
      [604_800, '7 天余量', '7 天用量', '7 天 review 余量', '7 天 review 用量'],
      [18_000, '5 小时余量', '5 小时用量', '5 小时 review 余量', '5 小时 review 用量'],
      [5_400, '90 分钟余量', '90 分钟用量', '90 分钟 review 余量', '90 分钟 review 用量'],
      [125, '125 秒余量', '125 秒用量', '125 秒 review 余量', '125 秒 review 用量'],
    ]],
  ] as const) {
    await setLanguage(language);
    const translate = i18n.getFixedT(language) as unknown as TFunction;
    for (const [seconds, remaining, usage, namedRemaining, namedUsage] of cases) {
      expect(displayOf('codex', { name: 'quota.window.used_percent', labels: { limit: 'codex', window_seconds: seconds } }, 'remaining', translate).name).toBe(remaining);
      expect(displayOf('codex', { name: 'quota.window.used_percent', labels: { limit: 'codex', window_seconds: seconds } }, 'used', translate).name).toBe(usage);
      expect(displayOf('codex', { name: 'quota.window.used_percent', labels: { limit: 'review', window_seconds: seconds } }, 'remaining', translate).name).toBe(namedRemaining);
      expect(displayOf('codex', { name: 'quota.window.used_percent', labels: { limit: 'review', window_seconds: seconds } }, 'used', translate).name).toBe(namedUsage);
    }
  }
});

it('renders equal fixed and encoded windows with consistent labels', async () => {
  for (const language of ['en', 'zh-Hans'] as const) {
    await setLanguage(language);
    for (const quotaDisplay of ['remaining', 'used'] as const) {
      for (const [quota, seconds] of [['five_hour', 18_000], ['seven_day', 604_800]] as const) {
        const fixed = displayOf('claude-code', { name: 'quota.utilization', labels: { quota } }, quotaDisplay);
        const encoded = displayOf('codex', { name: 'quota.window.used_percent', labels: { limit: 'codex', window_seconds: seconds } }, quotaDisplay);
        expect(fixed.name).toBe(encoded.name);
      }
    }
  }
});

it('names provider-specific quota series by the selected direction', async () => {
  for (const [language, expected] of [
    ['en', ['7-day Sonnet remaining', '7-day Sonnet usage', 'Extra usage', 'Extra usage', 'Session remaining', 'Session usage', '7-day remaining', '7-day usage']],
    ['zh-Hans', ['7 天 Sonnet 余量', '7 天 Sonnet 用量', '超额用量', '超额用量', '会话余量', '会话用量', '7 天余量', '7 天用量']],
  ] as const) {
    await setLanguage(language);
    const translate = i18n.getFixedT(language) as unknown as TFunction;
    expect([
      displayOf('claude-code', { name: 'quota.utilization', labels: { quota: 'seven_day_sonnet' } }, 'remaining', translate).name,
      displayOf('claude-code', { name: 'quota.utilization', labels: { quota: 'seven_day_sonnet' } }, 'used', translate).name,
      displayOf('claude-code', { name: 'quota.utilization', labels: { quota: 'extra_usage' } }, 'remaining', translate).name,
      displayOf('claude-code', { name: 'quota.utilization', labels: { quota: 'extra_usage' } }, 'used', translate).name,
      displayOf('ollama', { name: 'quota.remaining_percent', labels: { window: 'session' } }, 'remaining', translate).name,
      displayOf('ollama', { name: 'quota.remaining_percent', labels: { window: 'session' } }, 'used', translate).name,
      displayOf('ollama', { name: 'quota.remaining_percent', labels: { window: 'weekly' } }, 'remaining', translate).name,
      displayOf('ollama', { name: 'quota.remaining_percent', labels: { window: 'weekly' } }, 'used', translate).name,
    ]).toEqual(expected);
  }
});

it('names Ollama activity costs for the response range', async () => {
  for (const [language, labels] of [
    ['en', ['Past 24 hours cost', 'Past 7 days cost', 'Past month cost']],
    ['zh-Hans', ['最近 24 小时费用', '最近 7 天费用', '最近一个月费用']],
  ] as const) {
    await setLanguage(language);
    for (const [index, range] of ['24h', '7d', '30d'].entries()) {
      const display = displayOf('ollama', { name: 'activity.cost_usd', labels: { range } });
      expect(display.name).toBe(labels[index]);
      expect(display.unit).toBe('usd');
    }
  }
});

it('distinguishes usage, remaining, allowance, and balance labels', async () => {
  for (const [language, labels] of [
    ['en', ['Remaining', 'Usage', 'Allowance', 'Included allowance', 'Included balance', 'Purchased balance']],
    ['zh-Hans', ['余量', '用量', '额度', '套餐额度', '套餐余额', '购买余额']],
  ] as const) {
    await setLanguage(language);
    const translate = i18n.getFixedT(language) as unknown as TFunction;
    expect([
      displayOf('copilot', { name: 'quota.remaining', labels: { quota: 'premium_interactions' } }, 'remaining', translate).name,
      displayOf('copilot', { name: 'quota.remaining', labels: { quota: 'premium_interactions' } }, 'used', translate).name,
      displayOf('copilot', { name: 'quota.entitlement', labels: { quota: 'premium_interactions' } }, 'remaining', translate).name,
      displayOf('ollama', { name: 'allowance.usd', labels: { source: 'included' } }, 'remaining', translate).name,
      displayOf('ollama', { name: 'balance.usd', labels: { source: 'included' } }, 'remaining', translate).name,
      displayOf('ollama', { name: 'balance.usd', labels: { source: 'purchased' } }, 'remaining', translate).name,
    ]).toEqual(labels);
  }
});
