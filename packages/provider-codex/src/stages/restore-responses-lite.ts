import { restoreCodexResponsesCompactionResult, restoreCodexResponsesFrames } from '../responses-lite.ts';
import type { CodexResponsesHttpFacts } from './prepare-responses.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { OpenAIResponsesCompactionResult } from '@floway-dev/protocols/openai-responses';
import type { ProviderChatResponse, ProviderChatServices } from '@floway-dev/provider';

export const restoreCodexResponsesLite = defineStage<CodexResponsesHttpFacts, CodexResponsesHttpFacts, ProviderChatResponse<'openaiResponses'>, ProviderChatResponse<'openaiResponses'>, ProviderChatServices>({
  name: 'restoreCodexResponsesLite',
  through: {
    request: { needs: ['request.codex.responsesLite'], consumes: [], provides: [] },
    response: { needs: ['response.provider.output'], consumes: ['response.provider.output'], provides: ['response.provider.output'] },
  },
  execute: async (facts, next, use) => {
    const back = await next(move({ ...facts }));
    const lite = facts['request.codex.responsesLite'];
    const output = back['response.provider.output'];
    if (lite === null || output === null || !('kind' in output)) return move({ ...back });
    return move({
      ...back, 'response.provider.output': output.kind === 'value'
        ? { kind: 'value' as const, body: restoreCodexResponsesCompactionResult(output.body as OpenAIResponsesCompactionResult, lite.callableIdentities, lite.generatedPrefix) }
        : { kind: 'stream' as const, frames: use.recordProtocolFrames(restoreCodexResponsesFrames(output.frames, lite.callableIdentities, lite.requestEchoes)) },
    });
  },
});
