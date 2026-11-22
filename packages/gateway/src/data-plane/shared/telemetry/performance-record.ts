import type { PerformanceDimensions, PerformanceSample } from '../../../repo/types.ts';

export type PerformanceRecord =
  | { readonly kind: 'neutral' | 'zero-output-error'; readonly dimensions: PerformanceDimensions }
  | { readonly kind: 'sample'; readonly sample: PerformanceSample };

export const performanceRecord = (sample: {
  readonly dimensions: PerformanceDimensions;
  readonly firstOutputAt: number | null;
  readonly streamEndedAt: number | null;
  readonly upstreamStartedAt: number | null;
  readonly outputTokens: number;
  readonly failed: boolean;
}): PerformanceRecord => {
  const { dimensions, firstOutputAt, streamEndedAt, upstreamStartedAt, outputTokens, failed } = sample;
  if (outputTokens < 0) throw new Error(`recordPerformance: negative outputTokens=${outputTokens}`);
  if (dimensions.operation !== 'chat' || firstOutputAt === null || upstreamStartedAt === null || (failed && outputTokens === 0)) {
    return { kind: failed ? 'zero-output-error' : 'neutral', dimensions };
  }
  const ttftMs = Math.round(firstOutputAt - upstreamStartedAt);
  // The first decode signal approximates the first sampled token, including private reasoning.
  // https://github.com/open-telemetry/semantic-conventions-genai/blob/953dd22e3cecd3a397d742c349d2435d59c8b771/docs/gen-ai/gen-ai-metrics.md#metric-gen_aiservertime_per_output_token
  const tpot = outputTokens < 2 || streamEndedAt === null ? {} : {
    tpotUs: Math.round((streamEndedAt - firstOutputAt) * 1_000 / (outputTokens - 1)),
  };
  return { kind: 'sample', sample: { ...dimensions, ttftMs, ...tpot, success: !failed } };
};
