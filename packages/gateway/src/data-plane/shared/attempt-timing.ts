export interface AttemptTiming {
  upstreamCallStartedAt: number | null;
  firstOutputTokenAt: number | null;
}

// Matches gen_ai.server.time_to_first_token: measure from upstream dispatch
// through the first model output.
// https://github.com/open-telemetry/semantic-conventions-genai/blob/953dd22e3cecd3a397d742c349d2435d59c8b771/docs/gen-ai/gen-ai-metrics.md#metric-gen_aiservertime_to_first_token
export const attemptTtftMs = (attempt: AttemptTiming | undefined): number | null => {
  if (attempt?.upstreamCallStartedAt == null || attempt.firstOutputTokenAt == null) return null;
  return Math.round(attempt.firstOutputTokenAt - attempt.upstreamCallStartedAt);
};
