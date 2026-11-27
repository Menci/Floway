import { defineCopilotStage } from '../facts.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

// Qwen uses a vendor reasoning field to disable thinking.
// https://www.alibabacloud.com/help/en/model-studio/deep-thinking
export const normalizeQwen = defineCopilotStage({
  name: 'copilot.openaiResponses.normalizeQwen',
  through: {
    request: { needs: ['model', 'openaiResponses'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiResponses;
    if (!facts.model.enabledFlags.includes('vendor-qwen') || payload.reasoning?.effort !== 'none') return await scope.next(facts);
    const { reasoning: _reasoning, ...rest } = payload;
    const updated = { ...rest, enable_thinking: false } as CanonicalOpenAIResponsesPayload;
    return await scope.next({ ...facts, openaiResponses: updated });
  },
});
