export interface AttemptTiming {
  upstreamCallStartedAt: number | null;
  firstOutputTokenAt: number | null;
}

// Client-observed approximation of gen_ai.server.time_to_first_token, measured
// from upstream dispatch through first observable model output. Network and
// egress latency remain included; server-side sampling time is not observable.
// https://github.com/open-telemetry/semantic-conventions-genai/blob/953dd22e3cecd3a397d742c349d2435d59c8b771/docs/gen-ai/gen-ai-metrics.md#metric-gen_aiservertime_to_first_token
export const attemptTtftMs = (timing: AttemptTiming | undefined): number | null => {
  if (timing?.upstreamCallStartedAt == null || timing.firstOutputTokenAt == null) return null;
  return Math.round(timing.firstOutputTokenAt - timing.upstreamCallStartedAt);
};

// Continuations share one attempt. After the first output arrives, moving
// its dispatch anchor would invalidate the completed TTFT measurement.
// See UpstreamCallOptions.wrapUpstreamCall for the dispatch boundary.
export const stampUpstreamCallStart = (timing: AttemptTiming) =>
  <T>(dispatch: () => Promise<T>): Promise<T> => {
    if (timing.firstOutputTokenAt === null) timing.upstreamCallStartedAt = performance.now();
    return dispatch();
  };
