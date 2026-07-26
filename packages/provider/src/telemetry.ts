import type { ModelPricing } from '@floway-dev/protocols/common';

// Model identity attached to every provider result at the provider boundary
// so the identity is decided once.
export interface TelemetryModelIdentity {
  model: string;
  upstream: string;
  modelKey: string;
  pricing: ModelPricing | null;
}

// `chat`, `text_completion`, and `embeddings` are the OTel `gen_ai.operation.name`
// well-known values we route; `image_generation`, `image_edit`, `rerank`, and
// `audio_transcription` are gateway-defined extensions for concrete endpoints
// not covered by OTel. Extend only when a new route lands — no wildcard string.
// OTel canonical set:
// https://github.com/open-telemetry/semantic-conventions/blob/v1.37.0/docs/gen-ai/gen-ai-spans.md#gen_aioperationname
export const PERFORMANCE_OPERATIONS = [
  'chat',
  'text_completion',
  'embeddings',
  'image_generation',
  'image_edit',
  'rerank',
  'audio_transcription',
] as const;
export type PerformanceOperation = typeof PERFORMANCE_OPERATIONS[number];

export const parsePerformanceOperation = (value: unknown): PerformanceOperation => {
  if (typeof value === 'string' && (PERFORMANCE_OPERATIONS as readonly string[]).includes(value)) return value as PerformanceOperation;
  throw new TypeError(`Invalid performance operation: ${JSON.stringify(value)}`);
};

export interface PerformanceTelemetryContext {
  keyId: string;
  model: string;
  upstream: string;
  operation: PerformanceOperation;
  runtimeLocation: string;
}
