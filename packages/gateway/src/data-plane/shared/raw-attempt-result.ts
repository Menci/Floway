import type { PerformanceTelemetryContext, TelemetryModelIdentity } from '@floway-dev/provider';

export interface RawAttemptResult {
  readonly type: 'response';
  readonly http: Response;
  readonly performance: PerformanceTelemetryContext;
  readonly identity: TelemetryModelIdentity;
}
