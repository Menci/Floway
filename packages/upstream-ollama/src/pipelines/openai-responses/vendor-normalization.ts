import { defineStage } from '../facts.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { FlagId } from '@floway-dev/upstream';

const normalizeResponsesRequest = (payload: CanonicalOpenAIResponsesPayload, flags: readonly FlagId[]): CanonicalOpenAIResponsesPayload => {
  if (payload.reasoning?.effort !== 'none') return payload;
  const { reasoning: _reasoning, ...rest } = payload;
  // https://api-docs.deepseek.com/guides/thinking_mode
  if (flags.includes('vendor-deepseek')) {
    const shaped = { ...rest, thinking: { type: 'disabled' } };
    return shaped;
  }
  // https://www.alibabacloud.com/help/en/model-studio/deep-thinking
  if (flags.includes('vendor-qwen')) {
    const shaped = { ...rest, enable_thinking: false };
    return shaped;
  }
  return payload;
};

export const normalizeResponses = defineStage({
  name: 'ollama.openaiResponses.vendor-normalization',
  through: {
    request: { needs: ['openaiResponses', 'model'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = normalizeResponsesRequest(facts.openaiResponses, facts.model.enabledFlags);
    return await scope.next(payload === facts.openaiResponses ? facts : { ...facts, openaiResponses: payload });
  },
});
