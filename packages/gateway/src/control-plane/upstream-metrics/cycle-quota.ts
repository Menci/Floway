import type { Repo } from '../../repo/types.ts';
import { decimalStringIsZero, divideDecimalString, multiplyDecimalStrings, TELEMETRY_HOUR_MS, telemetryHourKey, type DecimalString } from '@floway-dev/protocols/common';
import type { UpstreamMetricDisplay, UpstreamMetricIdentity } from '@floway-dev/upstream';

export type CycleQuota =
  | { kind: 'estimated'; usd: DecimalString }
  | { kind: 'reported'; amount: number; unit: 'usd' | 'count' | 'credits' }
  | { kind: 'unavailable'; reason: 'scope' | 'observations' | 'prices' };

const floorHour = (instant: number) => Math.floor(instant / TELEMETRY_HOUR_MS) * TELEMETRY_HOUR_MS;

export const estimateCycleQuota = async (
  repo: Pick<Repo, 'upstreamMetrics' | 'usage'>,
  upstreamId: string,
  identity: UpstreamMetricIdentity,
  display: UpstreamMetricDisplay,
  cycle: { start: number; next: number | null; before: number },
): Promise<CycleQuota> => {
  const threshold = display.resetThreshold;
  if (threshold === undefined) throw new TypeError('A cycle quota requires a reset threshold');
  const { start, next, before } = cycle;
  if (typeof threshold.full !== 'number') {
    const { unit } = display;
    if (unit !== 'usd' && unit !== 'count' && unit !== 'credits') throw new TypeError('An absolute quota must have an absolute unit');
    // The observed reset already proves that remaining equaled the allowance.
    const sample = await repo.upstreamMetrics.latestSample(upstreamId, identity, start, start + 1);
    if (sample === null) return { kind: 'unavailable', reason: 'observations' };
    return { kind: 'reported', amount: display.toDisplayValue(sample.value), unit };
  }

  if (display.unit !== 'percent' || display.quotaCostScope !== 'upstream') return { kind: 'unavailable', reason: 'scope' };
  // Usage is rolled up in UTC hours. A closed cycle cannot include the
  // boundary hour owned by its successor, even if a sample exists there.
  const end = next === null ? before : floorHour(next);
  if (end <= start) return { kind: 'unavailable', reason: 'observations' };
  const sample = await repo.upstreamMetrics.latestSample(upstreamId, identity, start, end);
  if (sample === null) return { kind: 'unavailable', reason: 'observations' };
  const usedPercent = display.toDisplayValue(sample.value);
  if (!Number.isFinite(usedPercent) || usedPercent <= 0 || usedPercent > 100) return { kind: 'unavailable', reason: 'observations' };

  const spentUsd = await repo.usage.queryUpstreamCost(upstreamId, telemetryHourKey(floorHour(start)),
    telemetryHourKey(floorHour(sample.timestamp) + TELEMETRY_HOUR_MS));
  if (spentUsd === null) return { kind: 'unavailable', reason: 'prices' };
  if (decimalStringIsZero(spentUsd)) return { kind: 'unavailable', reason: 'observations' };
  return { kind: 'estimated', usd: divideDecimalString(multiplyDecimalStrings(spentUsd, '100'), String(usedPercent)) };
};
