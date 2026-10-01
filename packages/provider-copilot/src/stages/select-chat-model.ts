import type { CopilotChatFacts } from '../chat-facts.ts';
import { CONTEXT_1M_BETA, copilotModelSupportsFastVariant } from '../model-selection.ts';
import { rawModelFor } from '../operation-model.ts';
import type { CopilotRawModel } from '../types.ts';
import { takeHttpResponse } from '@floway-dev/http/pipeline';
import { defineStage, move, type Handed } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { isFastServiceTier } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ChatProviderOperation, ProviderChatResponse, ProviderOperationRequest, ProviderRequest, ProviderOperationPayloads } from '@floway-dev/provider';

export const selectCopilotChatModel = <O extends ChatProviderOperation>(operation: O) => defineStage<ProviderRequest<ProviderOperationPayloads[ChatProviderOperation]> & { 'request.provider.anthropicBeta'?: readonly string[] }, CopilotChatFacts, ProviderChatResponse<O>, ProviderChatResponse<O>, ProviderChatResponse<O>>({
  name: `selectCopilot${operation}`,
  through: {
    request: { needs: [...(operation === 'anthropicMessages' || operation === 'anthropicMessagesCountTokens' ? ['request.provider.anthropicBeta' as const] : []), 'request.provider.model', 'request.provider.payload', 'request.http.callId', 'request.http.headers'], consumes: ['request.provider.payload'], provides: ['request.provider.payload', 'request.provider.modelKey', ...(operation === 'openaiResponses' || operation === 'openaiResponsesCompact' ? ['request.provider.responsesAction' as const] : [])] },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: ['response.http.exchange', 'response.http.body', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls', 'response.provider.output'] },
  execute: async (facts, next) => {
    const model = facts['request.provider.model'];
    const payload = facts['request.provider.payload'];
    let modelKey: string;
    if (operation === 'anthropicMessages' || operation === 'anthropicMessagesCountTokens') {
      const body = payload as Omit<AnthropicMessagesPayload, 'model'>;
      if (operation === 'anthropicMessages' && body.speed === 'fast' && !copilotModelSupportsFastVariant((model.providerData as { rawModels: CopilotRawModel[] }).rawModels)) {
        // Anthropic Fast Mode requires a supporting model rather than silent downgrade.
        // https://docs.claude.com/en/build-with-claude/fast-mode
        const exchange = takeHttpResponse(Response.json({ type: 'error', error: { type: 'invalid_request_error', message: `'${model.id}' does not support the \`speed\` parameter.` } }, { status: 400 }));
        return move({ ...facts, 'response.http.exchange': exchange, 'response.http.body': exchange.body, 'response.provider.modelKey': model.id, 'response.provider.called': false, 'response.provider.previousCalls': [], 'response.provider.output': null });
      }
      modelKey = rawModelFor(model, 'anthropicMessages', {
        context1m: (facts as ProviderOperationRequest<'anthropicMessages'>)['request.provider.anthropicBeta'].includes(CONTEXT_1M_BETA),
        reasoningEffort: body.output_config?.effort,
        fast: operation === 'anthropicMessages' && body.speed === 'fast',
      }).id;
    } else if (operation === 'openaiChatCompletions') {
      const body = payload as Omit<OpenAIChatCompletionsPayload, 'model'>;
      modelKey = rawModelFor(model, 'openaiChatCompletions', { reasoningEffort: body.reasoning_effort && body.reasoning_effort !== 'none' ? body.reasoning_effort : undefined }).id;
    } else {
      const body = payload as Omit<CanonicalOpenAIResponsesPayload, 'model'>;
      modelKey = rawModelFor(model, 'openaiResponses', { reasoningEffort: body.reasoning?.effort && body.reasoning.effort !== 'none' ? body.reasoning.effort : undefined, fast: isFastServiceTier(body.service_tier) }).id;
    }
    return move({ ...await next(move({ ...facts, 'request.provider.payload': { ...payload, model: model.id }, 'request.provider.modelKey': modelKey, ...(operation === 'openaiResponses' || operation === 'openaiResponsesCompact' ? { 'request.provider.responsesAction': operation === 'openaiResponsesCompact' ? 'compact' as const : 'generate' as const } : {}) }) as Handed<CopilotChatFacts>) });
  },
});
