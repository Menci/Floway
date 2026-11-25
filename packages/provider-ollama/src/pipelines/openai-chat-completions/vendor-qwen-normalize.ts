import { factSpace, move, transform } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { GatewayFacts } from '@floway-dev/provider';

const { defineStage } = factSpace<Pick<GatewayFacts, 'provider.model' | 'request.openaiChatCompletions'>>();

// Qwen uses enable_thinking to disable reasoning.
// https://www.alibabacloud.com/help/en/model-studio/deep-thinking
export const normalizeQwen = defineStage({
  name: 'ollama.openaiChatCompletions.normalizeQwen',
  through: {
    request: { needs: ['provider.model', 'request.openaiChatCompletions'], provides: ['request.openaiChatCompletions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const payload = facts['request.openaiChatCompletions'];
      if (!facts['provider.model'].enabledFlags.includes('vendor-qwen') || payload.reasoning_effort !== 'none') return facts;
      const { reasoning_effort: _effort, ...rest } = payload;
      const wire = { ...rest, enable_thinking: false } as OpenAIChatCompletionsPayloadEx;
      return { ...facts, 'request.openaiChatCompletions': move(wire) };
    },
  })),
});
