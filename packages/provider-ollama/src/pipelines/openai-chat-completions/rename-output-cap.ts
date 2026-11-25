import { defineStage } from '../facts.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

// Ollama binds max_tokens to num_predict. An explicit max_tokens takes
// precedence when the caller provides both spellings.
// https://github.com/ollama/ollama/blob/9a4b136efefecb51b428d22e79b0f3d15769a1f8/openai/openai.go#L110-L125
// https://github.com/ollama/ollama/blob/9a4b136efefecb51b428d22e79b0f3d15769a1f8/openai/openai.go#L753-L755
const renameOutputCap = (payload: OpenAIChatCompletionsPayloadEx): OpenAIChatCompletionsPayloadEx => {
  const { max_completion_tokens: cap, ...rest } = payload;
  return cap === undefined || payload.max_tokens !== undefined ? payload : { ...rest, max_tokens: cap };
};

export const renameOutputCapStage = defineStage({
  name: 'ollama.openaiChatCompletions.rename-output-cap',
  through: {
    request: { needs: ['request.openaiChatCompletions'], provides: ['request.openaiChatCompletions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const body = facts['request.openaiChatCompletions'];
    const payload = renameOutputCap(body);
    return await scope.next(payload === body ? facts : { ...facts, 'request.openaiChatCompletions': payload });
  },
});
