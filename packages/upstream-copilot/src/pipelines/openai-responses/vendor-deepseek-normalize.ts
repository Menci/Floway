import { defineCopilotStage } from '../facts.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

// DeepSeek uses a vendor reasoning field to disable thinking.
// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
export const normalizeDeepSeek = defineCopilotStage({
  name: 'copilot.openaiResponses.normalizeDeepSeek',
  through: {
    request: { needs: ['model', 'openaiResponses'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiResponses;
    if (!facts.model.enabledFlags.includes('vendor-deepseek') || payload.reasoning?.effort !== 'none') return await scope.next(facts);
    const { reasoning: _reasoning, ...rest } = payload;
    const updated = { ...rest, thinking: { type: 'disabled' } } as CanonicalOpenAIResponsesPayload;
    return await scope.next({ ...facts, openaiResponses: updated });
  },
});
