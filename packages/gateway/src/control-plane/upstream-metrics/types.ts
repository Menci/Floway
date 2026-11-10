import type { UpstreamMetricDisplay, UpstreamMetricIdentity } from '@floway-dev/provider';

export interface UpstreamResetCyclesResponse {
  upstreamId: string;
  available: boolean;
  metrics: Array<{
    identity: UpstreamMetricIdentity;
    display: Pick<UpstreamMetricDisplay, 'name' | 'labelKey' | 'labelValues' | 'windowSeconds'>;
    currentStart: number | null;
    previousStart: number | null;
  }>;
}
