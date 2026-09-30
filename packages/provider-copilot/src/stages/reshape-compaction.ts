import type { ResponsesFacts } from '../chat-facts.ts';
import { compactionResponse } from '../compaction.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { OpenAIResponsesResult } from '@floway-dev/protocols/openai-responses';
import type { ProviderChatResponse } from '@floway-dev/provider';

export const reshapeCopilotCompaction = defineStage<ResponsesFacts, ResponsesFacts, ProviderChatResponse<'openaiResponsesCompact'>, ProviderChatResponse<'openaiResponsesCompact'>>({
  name: 'reshapeCopilotCompaction',
  through: {
    request: { needs: ['request.provider.payload'], consumes: [], provides: [] },
    response: { needs: ['response.provider.output'], consumes: ['response.provider.output'], provides: ['response.provider.output'] },
  },
  execute: async (facts, next) => {
    const back = await next(move({ ...facts }));
    const output = back['response.provider.output'];
    if (output === null || !('kind' in output) || output.kind !== 'value') return move({ ...back });
    return move({ ...back, 'response.provider.output': { ...output, body: compactionResponse(facts['request.provider.payload'].input, output.body as unknown as OpenAIResponsesResult) } });
  },
});
