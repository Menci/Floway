import { formatAnthropicMessagesError } from './format-errors.ts';
import { rewritePayload } from './rewrite-request.ts';
import { CONTEXT_1M_BETA, copilotModelSupportsFastVariant, copilotModelVariants, selectCopilotRawModel } from '../../model-selection.ts';
import { callerAnthropicBetas } from '../anthropic-messages/normalize-anthropic-beta.ts';
import { defineCopilotStage } from '../facts.ts';
import { isFastServiceTier } from '@floway-dev/protocols/common';

// Anthropic rejects Fast Mode when the provider model cannot serve it.
// https://docs.claude.com/en/build-with-claude/fast-mode
const anthropicMessages = defineCopilotStage({
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

const anthropicMessagesCountTokens = defineCopilotStage({
  name: 'copilot.anthropicMessagesCountTokens.selectModel',
  through: {
    request: { needs: ['provider.model', 'request.http', 'request.anthropicMessagesCountTokens'], provides: ['request.anthropicMessagesCountTokens'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts['request.anthropicMessagesCountTokens'];
    const model = selectCopilotRawModel(facts['provider.model'], 'anthropicMessages', {
      context1m: callerAnthropicBetas(facts['request.http'].headers).includes(CONTEXT_1M_BETA),
      reasoningEffort: payload.output_config?.effort ?? undefined,
    });
    return await scope.next({ ...facts, 'request.anthropicMessagesCountTokens': { ...payload, model } });
  },
});

const decision = defineCopilotStage({
  name: 'copilot.decision.selectModel',
  through: {
    request: { needs: ['provider.model', 'request.decision'], provides: ['request.decision'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts['request.decision'];
    const model = selectCopilotRawModel(facts['provider.model'], 'decision');
    return await scope.next({ ...facts, 'request.decision': { ...payload, raw: { ...payload.raw, model } } });
  },
});

const openaiImagesEdits = defineCopilotStage({
  name: 'copilot.openaiImagesEdits.selectModel',
  through: {
    request: { needs: ['provider.model', 'request.openaiImagesEdits'], provides: ['request.openaiImagesEdits'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts['request.openaiImagesEdits'];
    const model = selectCopilotRawModel(facts['provider.model'], 'openaiImagesEdits');
    return await scope.next({ ...facts, 'request.openaiImagesEdits': { ...payload, parameters: { ...payload.parameters, model } } });
  },
});

export const selectModel = {
  anthropicMessages,
  anthropicMessagesCountTokens,
  decision,
  openaiImagesEdits,
  openaiChatCompletions: rewritePayload.openaiChatCompletions('selectModel', (payload, model) => {
    // Copilot Chat Completions reports the base tier even if a fast id is used.
    // https://github.com/caozhiyuan/copilot-api/blob/cd0d0182eb4b9bf68a3376dc79728afa7f42ce07/src/services/copilot/create-chat-completions.ts#L28-L49
    const effort = payload.reasoning_effort;
    return {
      ...payload,
      model: selectCopilotRawModel(model, 'openaiChatCompletions', { reasoningEffort: effort === 'none' ? undefined : effort ?? undefined }),
    };
  }),
  openaiEmbeddings: rewritePayload.openaiEmbeddings('selectModel', (payload, model) => ({
    ...payload, model: selectCopilotRawModel(model, 'openaiEmbeddings'),
  })),
  openaiImagesGenerations: rewritePayload.openaiImagesGenerations('selectModel', (payload, model) => ({
    ...payload, model: selectCopilotRawModel(model, 'openaiImagesGenerations'),
  })),
  openaiResponses: rewritePayload.openaiResponses('selectModel', (payload, model) => {
    const effort = payload.reasoning?.effort;
    return {
      ...payload,
      model: selectCopilotRawModel(model, 'openaiResponses', {
        reasoningEffort: effort === 'none' ? undefined : effort ?? undefined,
        fast: isFastServiceTier(payload.service_tier),
      }),
    };
  }),
  openaiResponsesCompact: rewritePayload.openaiResponsesCompact('selectModel', (payload, model) => ({
    ...payload,
    model: selectCopilotRawModel(model, 'openaiResponses', { fast: isFastServiceTier(payload.service_tier) }),
  })),
};
