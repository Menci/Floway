import type { DashboardGranularity } from '../charts/dashboard-time';
import type { TelemetryOverviewScope, TelemetryOverviewSnapshot } from '@floway-dev/gateway/browser';
import { parseTelemetryHour, TELEMETRY_HOUR_MS, telemetryBucketHours } from '@floway-dev/protocols/browser';

type Window = { start: string; end: string };
type BucketGrid = { start: string; bucket: DashboardGranularity };
type Snapshot = TelemetryOverviewSnapshot<Window>;

const crossesBucket = (buckets: readonly Window[], hour: string): boolean =>
  buckets.some(bucket => bucket.start < hour && hour < bucket.end);

export const sameTelemetryBucketGrid = (previous: BucketGrid, next: BucketGrid): boolean =>
  previous.bucket === next.bucket
  && (parseTelemetryHour(next.start) - parseTelemetryHour(previous.start)) % (telemetryBucketHours(next.bucket) * TELEMETRY_HOUR_MS) === 0;

export const canContinueTelemetrySnapshot = <T extends Snapshot>(previous: T | undefined, window: Window): previous is T =>
  previous !== undefined && previous.start <= window.start && previous.end <= window.end
  && !crossesBucket(previous.buckets, window.start);

export const sameTelemetryScope = (left: TelemetryOverviewScope, right: TelemetryOverviewScope): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const mergeMetadata = <T extends { id: string | number }>(previous: T[], next: T[]): T[] =>
  [...new Map([...previous, ...next].map(value => [value.id, value])).values()];

export const mergeTelemetrySnapshot = <T extends Snapshot>(
  previous: T | undefined,
  response: T,
  start: string,
): T => {
  if (response.reset) return response;
  if (previous === undefined) throw new Error('Telemetry delta requires a baseline');
  if (crossesBucket(previous.buckets, response.start)) throw new Error('Telemetry delta crosses a retained bucket');
  return {
    ...response,
    start,
    buckets: [...previous.buckets.filter(bucket => bucket.start >= start && bucket.end <= response.start), ...response.buckets],
    users: response.metadataVisibility.complete ? response.users : mergeMetadata(previous.users, response.users),
    upstreams: response.metadataVisibility.complete ? response.upstreams : mergeMetadata(previous.upstreams, response.upstreams),
  };
};
