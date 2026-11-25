import type { UsageQuantities } from '../../repo/types.ts';
import type { StreamUsageObserver, UsageObserverContext } from '../pipeline/compute-usage.ts';
import { requestOnlyUsageMeasurement, tokenUsage, type UsageMeasurement } from '../shared/telemetry/usage.ts';
import { getHeader } from '@floway-dev/http';
import type { Result } from '@floway-dev/pipeline';
import { isJsonMediaType, parseDecimalString } from '@floway-dev/protocols/common';
import { isOpenAIAudioTranscriptionDoneEvent, type OpenAIAudioTranscriptionStreamEvent } from '@floway-dev/protocols/openai-audio';

// OpenAI transcription responses discriminate usage by `type`. Token-based
// models split input_token_details into text and audio metrics; without that
// optional split, the aggregate stays on the general input metric. Duration-
// based usage exposes seconds, while Whisper verbose JSON reports the same
// quantity as a top-level `duration`. Unknown breakdowns record the request
// only, while malformed fields under a known discriminator remain observable.
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L36378-L36562
const audioDurationMeasurement = (seconds: unknown, label: string): Result<UsageMeasurement, string> => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return { ok: false, error: `Audio transcription ${label} must be a finite non-negative number` };
  }
  return {
    ok: true,
    value: {
      quantities: { input_audio_seconds: parseDecimalString(String(seconds)) },
      pricingFacts: {},
      dumpTokenUsage: null,
    },
  };
};

export const openaiAudioTranscriptionUsageMeasurement = (body: unknown): Result<UsageMeasurement, string> => {
  if (!body || typeof body !== 'object') return { ok: true, value: requestOnlyUsageMeasurement() };
  if (!Object.hasOwn(body, 'usage')) {
    if (!Object.hasOwn(body, 'duration')) return { ok: true, value: requestOnlyUsageMeasurement() };
    return audioDurationMeasurement((body as { duration: unknown }).duration, 'duration');
  }
  const usage = (body as { usage: unknown }).usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return { ok: false, error: 'Audio transcription usage must be an object' };
  }
  const metric = usage as { type?: unknown; seconds?: unknown; input_tokens?: unknown; input_token_details?: unknown; output_tokens?: unknown; total_tokens?: unknown };

  if (metric.type === 'duration') {
    return audioDurationMeasurement(metric.seconds, 'duration usage.seconds');
  }

  if (metric.type !== 'tokens') return { ok: true, value: requestOnlyUsageMeasurement() };
  for (const [field, value] of [
    ['input_tokens', metric.input_tokens],
    ['output_tokens', metric.output_tokens],
    ['total_tokens', metric.total_tokens],
  ] as const) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      return { ok: false, error: `Audio transcription token usage.${field} must be a non-negative safe integer` };
    }
  }
  const inputTokens = metric.input_tokens as number;
  const outputTokens = metric.output_tokens as number;
  const totalTokens = metric.total_tokens as number;
  if (totalTokens !== inputTokens + outputTokens) {
    return { ok: false, error: 'Audio transcription token usage.total_tokens must equal input_tokens plus output_tokens' };
  }

  let inputQuantities: UsageQuantities = { input_tokens: parseDecimalString(String(inputTokens)) };
  if (metric.input_token_details !== undefined) {
    if (!metric.input_token_details || typeof metric.input_token_details !== 'object' || Array.isArray(metric.input_token_details)) {
      return { ok: false, error: 'Audio transcription token usage.input_token_details must be an object' };
    }
    const details = metric.input_token_details as { text_tokens?: unknown; audio_tokens?: unknown };
    for (const [field, value] of [
      ['text_tokens', details.text_tokens],
      ['audio_tokens', details.audio_tokens],
    ] as const) {
      if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
        return { ok: false, error: `Audio transcription token usage.input_token_details.${field} must be a non-negative safe integer` };
      }
    }
    const textTokens = details.text_tokens as number | undefined;
    const audioTokens = details.audio_tokens as number | undefined;
    if ((textTokens ?? 0) + (audioTokens ?? 0) > inputTokens) {
      return { ok: false, error: 'Audio transcription token usage.input_token_details must not exceed input_tokens' };
    }
    inputQuantities = {
      input_tokens: parseDecimalString(String(inputTokens - (audioTokens ?? 0))),
      ...(audioTokens === undefined ? {} : { input_audio_tokens: parseDecimalString(String(audioTokens)) }),
    };
  }
  return {
    ok: true,
    value: {
      quantities: {
        ...inputQuantities,
        output_tokens: parseDecimalString(String(outputTokens)),
      },
      pricingFacts: { inputTokens },
      dumpTokenUsage: tokenUsage({ input: inputTokens, output: outputTokens }),
    },
  };
};

export const measureOpenAIAudioTranscriptionUsage = (value: unknown, sourceApi: string): UsageMeasurement => {
  const measurement = openaiAudioTranscriptionUsageMeasurement(value);
  if (measurement.ok) return measurement.value;
  console.warn(
    `audio-transcription: invalid usage in 2xx upstream response for ${sourceApi}; usage row will be request-only`,
    measurement.error,
  );
  return requestOnlyUsageMeasurement();
};

const reported = (body: unknown): UsageMeasurement | null => {
  const measurement = measureOpenAIAudioTranscriptionUsage(body, '/audio/transcriptions');
  return Object.keys(measurement.quantities).length === 0 ? null : measurement;
};

export const measureOpenAIAudioTranscriptionsResult = (result: Uint8Array, { http }: UsageObserverContext): UsageMeasurement | null => {
  const contentType = http === null ? undefined : getHeader(http.headers, 'content-type');
  if (typeof contentType !== 'string' || !isJsonMediaType(contentType)) return null;

  const text = new TextDecoder().decode(result);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    console.warn('Floway could not read usage in a non-JSON OpenAI Audio Transcriptions response', error);
    return null;
  }
  return reported(parsed);
};

export const observeOpenAIAudioTranscriptionsStream = (): StreamUsageObserver<OpenAIAudioTranscriptionStreamEvent> => ({
  observe: event => isOpenAIAudioTranscriptionDoneEvent(event) ? reported(event) : null,
  finish: () => null,
});
