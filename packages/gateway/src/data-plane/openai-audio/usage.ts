import type { UsageQuantities } from '../../repo/types.ts';
import { computeUsage } from '../pipeline/compute-usage.ts';
import { requestOnlyUsageMeasurement, tokenUsage, tokenUsageMeasurement, type UsageMeasurement } from '../shared/telemetry/usage.ts';
import { getHeader } from '@floway-dev/http';
import { isJsonMediaType, isJsonObject, parseDecimalString } from '@floway-dev/protocols/common';
import { isOpenAIAudioTranscriptionDoneEvent } from '@floway-dev/protocols/openai-audio';

// OpenAI transcription responses discriminate usage by `type`. Token-based
// models split input_token_details into text and audio metrics; without that
// optional split, the aggregate stays on the general input metric. Duration-
// based usage exposes seconds, while Whisper verbose JSON reports the same
// quantity as a top-level `duration`. Unknown breakdowns record the request
// only, while malformed fields under a known discriminator remain observable.
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L36378-L36562
const audioDurationMeasurement = (seconds: unknown, label: string): UsageMeasurement => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Audio transcription ${label} must be a finite non-negative number`);
  }
  return {
    quantities: { input_audio_seconds: parseDecimalString(String(seconds)) },
    pricingFacts: {},
    dumpTokenUsage: null,
  };
};

export const openaiAudioTranscriptionUsageMeasurement = (body: unknown): UsageMeasurement => {
  if (!body || typeof body !== 'object') return requestOnlyUsageMeasurement();
  if (!Object.hasOwn(body, 'usage')) {
    if (!Object.hasOwn(body, 'duration')) return requestOnlyUsageMeasurement();
    return audioDurationMeasurement((body as { duration: unknown }).duration, 'duration');
  }
  const usage = (body as { usage: unknown }).usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    throw new Error('Audio transcription usage must be an object');
  }
  const metric = usage as { type?: unknown; seconds?: unknown; input_tokens?: unknown; input_token_details?: unknown; output_tokens?: unknown; total_tokens?: unknown };

  if (metric.type === 'duration') {
    return audioDurationMeasurement(metric.seconds, 'duration usage.seconds');
  }

  if (metric.type !== 'tokens') return requestOnlyUsageMeasurement();
  for (const [field, value] of [
    ['input_tokens', metric.input_tokens],
    ['output_tokens', metric.output_tokens],
    ['total_tokens', metric.total_tokens],
  ] as const) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Audio transcription token usage.${field} must be a non-negative safe integer`);
    }
  }
  const inputTokens = metric.input_tokens as number;
  const outputTokens = metric.output_tokens as number;
  const totalTokens = metric.total_tokens as number;
  if (totalTokens !== inputTokens + outputTokens) {
    throw new Error('Audio transcription token usage.total_tokens must equal input_tokens plus output_tokens');
  }

  let inputQuantities: UsageQuantities = { input_tokens: parseDecimalString(String(inputTokens)) };
  if (metric.input_token_details !== undefined) {
    if (!metric.input_token_details || typeof metric.input_token_details !== 'object' || Array.isArray(metric.input_token_details)) {
      throw new Error('Audio transcription token usage.input_token_details must be an object');
    }
    const details = metric.input_token_details as { text_tokens?: unknown; audio_tokens?: unknown };
    for (const [field, value] of [
      ['text_tokens', details.text_tokens],
      ['audio_tokens', details.audio_tokens],
    ] as const) {
      if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
        throw new Error(`Audio transcription token usage.input_token_details.${field} must be a non-negative safe integer`);
      }
    }
    const textTokens = details.text_tokens as number | undefined;
    const audioTokens = details.audio_tokens as number | undefined;
    if ((textTokens ?? 0) + (audioTokens ?? 0) > inputTokens) {
      throw new Error('Audio transcription token usage.input_token_details must not exceed input_tokens');
    }
    inputQuantities = {
      input_tokens: parseDecimalString(String(inputTokens - (audioTokens ?? 0))),
      ...(audioTokens === undefined ? {} : { input_audio_tokens: parseDecimalString(String(audioTokens)) }),
    };
  }
  return {
    quantities: {
      ...inputQuantities,
      output_tokens: parseDecimalString(String(outputTokens)),
    },
    pricingFacts: { inputTokens },
    dumpTokenUsage: tokenUsage({ input: inputTokens, output: outputTokens }),
  };
};

export const measureOpenAIAudioTranscriptionUsage = (value: unknown, sourceApi: string): UsageMeasurement => {
  try {
    return openaiAudioTranscriptionUsageMeasurement(value);
  } catch (error) {
    console.warn(
      `audio-transcription: invalid usage in 2xx upstream response for ${sourceApi}; usage row will be request-only`,
      error instanceof Error ? error.message : String(error),
    );
    return requestOnlyUsageMeasurement();
  }
};

const transcriptionApi = '/audio/transcriptions';

export const computeOpenAIAudioTranscriptionsUsage = computeUsage('openaiAudioTranscriptions', {
  needs: ['response.http'] as const,
  result(bytes, { 'response.http': http }) {
    if (http === null) throw new Error('OpenAI Audio Transcriptions result requires an HTTP response');
    const mediaType = getHeader(http.headers, 'content-type');
    if (typeof mediaType !== 'string' || !isJsonMediaType(mediaType)) return [requestOnlyUsageMeasurement()];
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return [measureOpenAIAudioTranscriptionUsage(value, transcriptionApi)];
  },
  stream: () => ({
    frame: ({ data }) => isOpenAIAudioTranscriptionDoneEvent(data) ? [measureOpenAIAudioTranscriptionUsage(data, transcriptionApi)] : undefined,
    done: () => [requestOnlyUsageMeasurement()],
  }),
});

export const computeOpenAIAudioSpeechUsage = computeUsage('openaiAudioSpeech', {
  result: () => [requestOnlyUsageMeasurement()],
  stream: () => ({
    frame(event) {
      // https://github.com/openai/openai-dotnet/blob/fa869ba7c906d954236c541b3a1e7920e79a12f0/OpenAI/src/Generated/Models/Audio/InternalSpeechAudioDoneEvent.cs
      // https://github.com/openai/openai-dotnet/blob/fa869ba7c906d954236c541b3a1e7920e79a12f0/OpenAI/src/Generated/Models/Audio/SpeechTokenUsage.Serialization.cs
      if (event.type !== 'speech.audio.done' || !isJsonObject(event.usage)) return undefined;
      const { input_tokens: input, output_tokens: output, total_tokens: total } = event.usage;
      if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0
        || typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0
        || total !== input + output) {
        return undefined;
      }
      return [tokenUsageMeasurement({ input, output })];
    },
    done: () => [requestOnlyUsageMeasurement()],
  }),
});
