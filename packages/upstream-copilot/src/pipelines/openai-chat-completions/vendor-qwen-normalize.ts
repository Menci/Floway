import { defineCopilotStage } from '../facts.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

// Qwen uses a vendor reasoning field to disable thinking.
// https://www.alibabacloud.com/help/en/model-studio/deep-thinking
export const normalizeQwen = defineCopilotStage({
  name: 'copilot.openaiChatCompletions.normalizeQwen',
  through: {
    request: { needs: ['model', 'openaiChatCompletions'], provides: ['openaiChatCompletions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiChatCompletions;
    if (!facts.model.enabledFlags.includes('vendor-qwen') || payload.reasoning_effort !== 'none') return await scope.next(facts);
    const { reasoning_effort: _reasoning, ...rest } = payload;
    const updated = { ...rest, enable_thinking: false } as OpenAIChatCompletionsPayloadEx;
    return await scope.next({ ...facts, openaiChatCompletions: updated });
  },
});
