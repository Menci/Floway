import type { UsageQuantities } from '../../../repo/types.ts';
import { observeUsage } from '../../pipeline/compute-usage.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { requestOnlyUsageMeasurement, tokenUsage, type UsageMeasurement } from '../../shared/telemetry/usage.ts';
import { getHeader, type HttpResponseFact } from '@floway-dev/http';
import { isJsonMediaType, isJsonObject, parseDecimalString, parseJSONWithRawNumbers } from '@floway-dev/protocols/common';
import { isOpenAIAudioTranscriptionDoneEvent } from '@floway-dev/protocols/openai-audio';

export const computeOpenAIAudioTranscriptionsUsage = defineStage({
  name: 'openaiAudioTranscriptions.usage',
  through: {
    request: { needs: ['model'], provides: [], consumes: [] },
    response: { needs: ['openaiAudioTranscriptions', 'usageModelKey?', 'http'], provides: ['openaiAudioTranscriptions', 'usage'], consumes: ['usageModelKey'] },
  },
  async execute(facts, scope) {
    const { model } = facts;
    const { usageModelKey, ...answer } = await scope.next(facts);
    const { http } = answer;
    const observed = observeUsage(scope, answer.openaiAudioTranscriptions, usageModelKey ?? model.upstreamModelId, {
      result: bytes => [measureTranscriptionResult(bytes, http, scope.log)],
      stream: () => ({
        frame: ({ data }) => isOpenAIAudioTranscriptionDoneEvent(data) ? [measureTranscription(data, scope.log)] : undefined,
        done: () => [requestOnlyUsageMeasurement()],
      }),
    });
    return { ...answer, openaiAudioTranscriptions: observed.outcome, usage: observed.usage };
  },
});

// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L36378-L36562
const durationUsage = (seconds: unknown, field: string): UsageMeasurement => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError(`Audio transcription ${field} must be a finite non-negative number`);
  }
  return {
    quantities: { input_audio_seconds: parseDecimalString(String(seconds)) },
    pricingFacts: {},
    dumpTokenUsage: null,
  };
};

const tokenCount = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Audio transcription usage.${field} must be a non-negative safe integer`);
  }
  return value;
};

const measure = (body: unknown): UsageMeasurement => {
  if (!isJsonObject(body)) return requestOnlyUsageMeasurement();
  if (!Object.hasOwn(body, 'usage')) {
    return Object.hasOwn(body, 'duration') ? durationUsage(body.duration, 'duration') : requestOnlyUsageMeasurement();
  }
  const { usage } = body;
  if (!isJsonObject(usage)) throw new TypeError('Audio transcription usage must be an object');
  if (usage.type === 'duration') return durationUsage(usage.seconds, 'duration usage.seconds');
  if (usage.type !== 'tokens') return requestOnlyUsageMeasurement();

  const input = tokenCount(usage.input_tokens, 'input_tokens');
  const output = tokenCount(usage.output_tokens, 'output_tokens');
  const total = tokenCount(usage.total_tokens, 'total_tokens');
  if (total !== input + output) throw new RangeError('Audio transcription usage.total_tokens must equal input_tokens plus output_tokens');

  const details = usage.input_token_details;
  let audio: number | undefined;
  if (details !== undefined) {
    if (!isJsonObject(details)) throw new TypeError('Audio transcription usage.input_token_details must be an object');
    const text = details.text_tokens === undefined ? 0 : tokenCount(details.text_tokens, 'input_token_details.text_tokens');
    audio = details.audio_tokens === undefined ? undefined : tokenCount(details.audio_tokens, 'input_token_details.audio_tokens');
    if (text + (audio ?? 0) > input) throw new RangeError('Audio transcription usage.input_token_details must not exceed input_tokens');
  }
  const quantities: UsageQuantities = {
    input_tokens: parseDecimalString(String(input - (audio ?? 0))),
    ...(audio === undefined ? {} : { input_audio_tokens: parseDecimalString(String(audio)) }),
    output_tokens: parseDecimalString(String(output)),
  };
  return {
    quantities,
    pricingFacts: { inputTokens: input },
    dumpTokenUsage: tokenUsage({ input, output }),
  };
};

interface UsageLogger {
  warn(message: string): unknown;
}

const measureTranscription = (value: unknown, log: UsageLogger): UsageMeasurement => {
  try {
    return measure(value);
  } catch (error) {
    if (!(error instanceof RangeError) && !(error instanceof TypeError)) throw error;
    log.warn(`Invalid audio transcription usage in a successful response: ${error.message}`);
    return requestOnlyUsageMeasurement();
  }
};

const measureTranscriptionResult = (bytes: Uint8Array, http: HttpResponseFact | null, log: UsageLogger): UsageMeasurement => {
  if (http === null) throw new Error('OpenAI Audio Transcriptions result requires an HTTP response');
  const mediaType = getHeader(http.headers, 'content-type');
  if (typeof mediaType !== 'string' || !isJsonMediaType(mediaType)) return requestOnlyUsageMeasurement();
  return measureTranscription(parseJSONWithRawNumbers(new TextDecoder().decode(bytes)), log);
};
