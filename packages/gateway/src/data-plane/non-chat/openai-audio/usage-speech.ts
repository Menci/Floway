import { observeUsage } from '../../pipeline/compute-usage.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { requestOnlyUsageMeasurement, tokenUsageMeasurement } from '../../shared/telemetry/usage.ts';
import { isJsonObject } from '@floway-dev/protocols/common';
import type { OpenAIAudioSpeechStreamEvent } from '@floway-dev/protocols/openai-audio';

export const computeOpenAIAudioSpeechUsage = defineStage({
  name: 'openaiAudioSpeech.usage',
  through: {
    request: { needs: ['model'], provides: [], consumes: [] },
    response: { needs: ['openaiAudioSpeech', 'usageModelKey?'], provides: ['openaiAudioSpeech', 'usage'], consumes: ['usageModelKey'] },
  },
  async execute(facts, scope) {
    const { model } = facts;
    const { usageModelKey, ...answer } = await scope.next(facts);
    const observed = observeUsage(scope, answer.openaiAudioSpeech, usageModelKey ?? model.upstreamModelId, speechUsageReaders);
    return { ...answer, openaiAudioSpeech: observed.outcome, usage: observed.usage };
  },
});

// https://github.com/openai/openai-dotnet/blob/fa869ba7c906d954236c541b3a1e7920e79a12f0/OpenAI/src/Generated/Models/Audio/InternalSpeechAudioDoneEvent.cs
// https://github.com/openai/openai-dotnet/blob/fa869ba7c906d954236c541b3a1e7920e79a12f0/OpenAI/src/Generated/Models/Audio/SpeechTokenUsage.Serialization.cs
const speechUsageReaders = {
  result: () => [requestOnlyUsageMeasurement()],
  stream: () => ({
    frame(event: OpenAIAudioSpeechStreamEvent) {
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
};
