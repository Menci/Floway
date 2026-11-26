import { currentHour } from './hour.ts';
import { getRepo } from '../../../repo/index.ts';
import type { PerformanceDimensions } from '../../../repo/types.ts';
import { attemptTtftMs, type AttemptTiming } from '../attempt-timing.ts';
import type { PerformanceTelemetryContext } from '@floway-dev/provider';

export const persistPerformance = (
  timing: AttemptTiming,
  telemetry: PerformanceTelemetryContext,
  failed: boolean,
  outputTokens: number,
  requestFinishedAt: number,
): Promise<void> => {
  if (outputTokens < 0) throw new Error(`recordPerformance: negative outputTokens=${outputTokens}`);
  const dims: PerformanceDimensions = { ...telemetry, hour: currentHour() };
  const ttftMs = attemptTtftMs(timing);
  if (
    telemetry.operation !== 'chat' ||
    ttftMs === null ||
    timing.firstOutputTokenAt === null ||
    (failed && outputTokens === 0)
  ) {
    return failed ? getRepo().performance.recordZeroOutputError(dims) : getRepo().performance.recordNeutral(dims);
  }
  const success = !failed;
  if (outputTokens < 2) {
    return getRepo().performance.recordSample({ ...dims, ttftMs, success });
  }
  // The first observed decode signal approximates the first sampled token,
  // including private reasoning without visible text. Estimate the following
  // inter-token generation interval using outputTokens - 1, following the
  // OpenTelemetry GenAI spec
  // gen_ai.server.time_per_output_token
  // (https://github.com/open-telemetry/semantic-conventions-genai/blob/953dd22e3cecd3a397d742c349d2435d59c8b771/docs/gen-ai/gen-ai-metrics.md#metric-gen_aiservertime_per_output_token)
  // and Envoy AI Gateway
  // (https://aigateway.envoyproxy.io/docs/capabilities/observability/metrics/).
  const streamDeltaMs = requestFinishedAt - timing.firstOutputTokenAt;
  const tpotUs = Math.round((streamDeltaMs * 1_000) / (outputTokens - 1));
  return getRepo().performance.recordSample({ ...dims, ttftMs, tpotUs, success });
};
