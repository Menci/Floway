import { afterEach, expect, it } from 'vitest';

import type { UpstreamMetricsMetadata } from '../../../src/components/upstream-metrics/data';
import { resolveUpstreamMetricDisplays } from '../../../src/components/upstream-metrics/display-name';
import { i18n, setLanguage } from '../../../src/i18n';
import type { TFunction } from '../../../src/i18n/translation';
import { normalizeUpstreamMetricIdentity } from '@floway-dev/upstream/browser';

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
