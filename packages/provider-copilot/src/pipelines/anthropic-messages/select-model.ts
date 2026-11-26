import { callerAnthropicBetas } from './normalize-anthropic-beta.ts';
import { CONTEXT_1M_BETA, copilotModelSupportsFastVariant, copilotModelVariants, selectCopilotRawModel } from '../../model-selection.ts';
import { defineCopilotStage } from '../facts.ts';
import { formatAnthropicMessagesError } from '../shared/format-errors.ts';

// Anthropic rejects Fast Mode when the provider model cannot serve it.
// https://docs.claude.com/en/build-with-claude/fast-mode
export const selectModel = defineCopilotStage({
  name: 'copilot.anthropicMessages.selectModel',
  through: {
    request: { needs: ['provider.model', 'request.http', 'request.anthropicMessages'], provides: ['request.anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.anthropicMessages'] },
  async execute(facts, scope) {
    const model = facts['provider.model'];
    const payload = facts['request.anthropicMessages'];
    const fast = payload.speed === 'fast';
    if (fast && !copilotModelSupportsFastVariant(copilotModelVariants(model))) {
      const error = formatAnthropicMessagesError(400, `'${model.id}' does not support the \`speed\` parameter.`);
      return {
        'response.http': { status: 400, statusText: 'Bad Request', headers: [['content-type', 'application/json']], body: null },
        'response.anthropicMessages': { kind: 'error', source: 'local', error },
      };
    }
    const selected = selectCopilotRawModel(model, 'anthropicMessages', {
      context1m: callerAnthropicBetas(facts['request.http'].headers).includes(CONTEXT_1M_BETA),
      reasoningEffort: payload.output_config?.effort ?? undefined,
      fast,
    });
    return await scope.next({ ...facts, 'request.anthropicMessages': { ...payload, model: selected } });
  },
});
