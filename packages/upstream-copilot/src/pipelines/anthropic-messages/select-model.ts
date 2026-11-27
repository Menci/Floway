import { rawModelFor, type CopilotUpstreamData } from '../../catalog.ts';
import { CONTEXT_1M_BETA, copilotModelSupportsFastVariant } from '../../model-selection.ts';
import { callerAnthropicBetas } from '../anthropic-messages/normalize-anthropic-beta.ts';
import { defineCopilotStage } from '../facts.ts';
import { formatAnthropicMessagesError } from '../shared/format-errors.ts';

export const selectModel = defineCopilotStage({
  name: 'copilot.anthropicMessages.selectModel',
  through: {
    request: { needs: ['anthropicMessages', 'model', 'http'], provides: ['copilot.modelId'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'anthropicMessages'] },
  async execute(facts, scope) {
    // Anthropic Fast Mode is a hard request-side contract.
    // https://docs.claude.com/en/build-with-claude/fast-mode
    const rawModels = (facts.model.upstreamData as CopilotUpstreamData).rawModels;
    if (facts.anthropicMessages.speed === 'fast' && !copilotModelSupportsFastVariant(rawModels)) {
      return {
        http: { status: 400, statusText: 'Bad Request', headers: [['content-type', 'application/json']], body: null },
        anthropicMessages: { kind: 'error', source: 'local', error: formatAnthropicMessagesError(400, `'${facts.model.id}' does not support the \`speed\` parameter.`) },
      };
    }

    const { id } = rawModelFor(facts.model, 'anthropicMessages', {
      context1m: callerAnthropicBetas(facts.http.headers).includes(CONTEXT_1M_BETA),
      reasoningEffort: facts.anthropicMessages.output_config?.effort ?? undefined,
      fast: facts.anthropicMessages.speed === 'fast',
    });
    return await scope.next({ ...facts, 'copilot.modelId': id });
  },
});
