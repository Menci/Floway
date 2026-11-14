import { projectMovedCodexResponsesFields } from '../responses-lite.ts';
import type { CodexResponsesHttpFacts } from './prepare-responses.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProviderChatResponse, ProviderChatServices } from '@floway-dev/provider';

export const projectCodexMovedResponsesFields = defineStage<CodexResponsesHttpFacts, CodexResponsesHttpFacts, ProviderChatResponse<'openaiResponses'>, ProviderChatResponse<'openaiResponses'>, ProviderChatServices>({
  name: 'projectCodexMovedResponsesFields',
  through: {
    request: { needs: ['request.codex.movedResponsesFields'], consumes: [], provides: [] },
    response: { needs: ['response.provider.output'], consumes: ['response.provider.output'], provides: ['response.provider.output'] },
  },
  execute: async (facts, next, use) => {
    const back = await next(move({ ...facts }));
    const movedFields = facts['request.codex.movedResponsesFields'];
    const output = back['response.provider.output'];
    return Object.keys(movedFields).length > 0 && output !== null && 'kind' in output && output.kind === 'stream'
      ? move({ ...back, 'response.provider.output': { kind: 'stream' as const, frames: use.recordProtocolFrames(projectMovedCodexResponsesFields(output.frames, movedFields)) } })
      : move({ ...back });
  },
});
