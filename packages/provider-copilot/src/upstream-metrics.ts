import { copilotCreditsToUsd, isCopilotCreditQuota } from './quota-credits.ts';
import { assertCanonicalCopilotQuotaUnlimited } from './quota-entitlement.ts';
import type { CopilotQuotaSnapshot } from './quota.ts';
import type { UpstreamMetrics } from '@floway-dev/provider';
import { groupUpstreamMetricSamples, resolveUpstreamMetricDisplaySeries as resolveDisplaySeries, upstreamMetricAxisPriority, upstreamMetricIdentityKey, type UpstreamMetricDisplay, type UpstreamMetricDisplayOptions, type UpstreamMetricDisplaySeries, type UpstreamMetricIdentity, type UpstreamMetricSample } from '@floway-dev/provider/browser';

// https://github.com/github/copilot-sdk/blob/6be623b01b194a61466385e3f708639ec98ce8ac/nodejs/src/generated/rpc.ts#L6572
export const copilotMetrics = (snapshot: CopilotQuotaSnapshot): UpstreamMetrics => {
  const metrics = [];
  for (const [key, quota] of Object.entries(snapshot.quotas)) {
    assertCanonicalCopilotQuotaUnlimited(quota.entitlement, quota.unlimited);
    if (quota.unlimited || quota.entitlement === 0) continue;
    metrics.push({ name: 'quota.remaining', labels: { quota: key }, value: quota.quota_remaining });
    metrics.push({ name: 'quota.entitlement', labels: { quota: key }, value: quota.entitlement });
  }
  return metrics;
};

export const resolveUpstreamMetricDisplay = ({ name, labels }: UpstreamMetricIdentity, _options: UpstreamMetricDisplayOptions): UpstreamMetricDisplay | null => {
  const quota = labels.quota;
  if ((name !== 'quota.remaining' && name !== 'quota.used' && name !== 'quota.entitlement') || typeof quota !== 'string') return null;
  const quantity = name === 'quota.entitlement' ? 'entitlement' : name === 'quota.used' ? 'used' : 'remaining';
  const credits = isCopilotCreditQuota(quota);
  const keyed = quota === 'premium_interactions' ? 'premiumInteractions' : quota === 'chat' ? 'chat' : quota === 'completions' ? 'completions' : 'other';
  const labelKey = `dashboard.upstreams.copilotQuota.${keyed}.${quantity === 'entitlement' ? 'allowance' : quantity === 'used' ? 'usage' : 'remaining'}` as const;
  const labelValues = keyed === 'other' ? { name: quota } : undefined;
  return { name: `${quantity}_${quota}`, labelKey, labelValues, unit: credits ? 'usd' : 'count', axisPriority: quantity === 'entitlement' ? upstreamMetricAxisPriority.entitlement : upstreamMetricAxisPriority.remainingQuota, windowSeconds: null, emptyValue: null, form: quantity === 'entitlement' ? 'line' : 'area', toDisplayValue: credits ? copilotCreditsToUsd : value => value };
};

export const resolveUpstreamMetricDisplays = (samples: readonly UpstreamMetricSample[], options: UpstreamMetricDisplayOptions): UpstreamMetricDisplaySeries[] => {
  const groups = groupUpstreamMetricSamples(samples);
  const byIdentity = new Map(groups.map(group => [upstreamMetricIdentityKey(group.identity), group]));
  const consumed = new Set<string>();
  const result: UpstreamMetricDisplaySeries[] = [];

  for (const remaining of groups) {
    const quota = remaining.identity.labels.quota;
    if (remaining.identity.name !== 'quota.remaining' || typeof quota !== 'string') continue;
    const remainingKey = upstreamMetricIdentityKey(remaining.identity);
    const entitlementIdentity = { name: 'quota.entitlement', labels: { quota } } satisfies UpstreamMetricIdentity;
    const entitlementKey = upstreamMetricIdentityKey(entitlementIdentity);
    const entitlement = byIdentity.get(entitlementKey);
    if (entitlement === undefined) throw new TypeError(`Copilot quota ${quota} has remaining observations without an entitlement series`);

    const selectedIdentity = options.quotaDisplay === 'remaining'
      ? remaining.identity
      : { name: 'quota.used', labels: { quota } } satisfies UpstreamMetricIdentity;
    const entitlementByTimestamp = new Map(entitlement.samples.map(sample => [sample.timestamp, sample.value]));
    const selectedSamples = options.quotaDisplay === 'remaining'
      ? remaining.samples
      : remaining.samples.map(sample => {
          const allowance = entitlementByTimestamp.get(sample.timestamp);
          if (allowance === undefined) throw new TypeError(`Copilot quota ${quota} has no entitlement observation at ${sample.timestamp}`);
          return { ...selectedIdentity, timestamp: sample.timestamp, value: allowance - sample.value };
        });
    const selectedDisplay = resolveUpstreamMetricDisplay(selectedIdentity, options);
    const entitlementDisplay = resolveUpstreamMetricDisplay(entitlementIdentity, options);
    if (selectedDisplay === null || entitlementDisplay === null) throw new TypeError(`Copilot quota ${quota} could not be displayed`);

    result.push({ identity: selectedIdentity, display: selectedDisplay, samples: selectedSamples });
    result.push({ identity: entitlementIdentity, display: entitlementDisplay, samples: entitlement.samples });
    consumed.add(remainingKey);
    consumed.add(entitlementKey);
  }

  const unconsumed = groups.flatMap(group => consumed.has(upstreamMetricIdentityKey(group.identity)) ? [] : group.samples);
  return result.concat(resolveDisplaySeries(unconsumed, options, resolveUpstreamMetricDisplay));
};
