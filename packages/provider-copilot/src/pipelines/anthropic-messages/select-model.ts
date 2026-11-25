import { CONTEXT_1M_BETA } from '../../model-selection.ts';
import { defineCopilotStage } from '../facts.ts';
import { readBetaHeaders } from './read-beta-headers.ts';
import { parseCredentialFailure } from '../shared/authorize.ts';
import { move } from '@floway-dev/pipeline';
import { formatAnthropicMessagesError } from '@floway-dev/protocols/anthropic-messages';

export const selectAnthropicMessagesModel = (generate: boolean) => defineCopilotStage({
  name: generate ? 'copilot.anthropicMessages.selectModel' : 'copilot.anthropicMessagesCountTokens.selectModel',
  through: {
    request: {
      needs: ['request.anthropicMessages', 'request.http', 'provider.upstream', 'provider.model'],
      provides: ['copilot.modelId'],
      consumes: [],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.modelKey', 'response.anthropicMessages'] },
  async execute(facts, scope) {
    const model = facts['provider.model'];
    const request = facts['request.anthropicMessages'];
    const selected = await scope.services.copilot.selectModel(facts['provider.upstream'].id, model.upstreamModelId, 'anthropicMessages', {
      context1m: readBetaHeaders(facts['request.http'].headers).includes(CONTEXT_1M_BETA),
      reasoningEffort: request.output_config?.effort ?? undefined,
      fast: generate && 'speed' in request && request.speed === 'fast',
    });
    if (selected.kind === 'local') {
      const { http, outcome } = await parseCredentialFailure(selected, formatAnthropicMessagesError);
      return { 'response.http': move(http), 'response.modelKey': model.upstreamModelId, 'response.anthropicMessages': move(outcome) };
    }
    if (selected.kind === 'unsupportedFast') {
      // Anthropic returns a client error for an unsupported Fast Mode request.
      // https://docs.claude.com/en/build-with-claude/fast-mode
      // https://github.com/Yeachan-Heo/gajae-code/blob/main/packages/ai/test/anthropic-fast-mode.test.ts
      return {
        'response.http': move({ status: 400, statusText: '', headers: [['content-type', 'application/json']], body: null }),
        'response.modelKey': model.upstreamModelId,
        'response.anthropicMessages': move({
          kind: 'error',
          source: 'local',
          error: formatAnthropicMessagesError(400, `'${model.id}' does not support the \`speed\` parameter.`, { type: 'invalid_request_error' }),
        }),
      };
    }

    return await scope.next({ ...facts, 'copilot.modelId': selected.id });
  },
});
