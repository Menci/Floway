import type { Fields } from './facts.ts';
import { providerEntry } from '../../pipeline/provider-entry.ts';
import type { ChatServices } from '../services.ts';
import { applyRulesToUpstreamGeminiGenerateContent } from '../shared/alias-rules.ts';
import { providerChatAnswer } from '../shared/provider-answer.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProviderChatResponse, ProviderOperationRequest, ProviderOperationResponse } from '@floway-dev/provider';

export const callGeminiGenerateContentUpstream = <O extends 'geminiGenerateContent' | 'geminiGenerateContentCountTokens'>(operation: O) => defineStage<
  Fields<'request.chat.geminiGenerateContent' | 'route.attempt' | 'ingress.http.headers'>,
  ProviderOperationRequest<O>,
  ProviderOperationResponse<O>,
  Fields<'response.chat.geminiGenerateContent' | 'response.usage.billable' | 'response.http.headers' | 'response.http.status' | 'response.http.body'>,
  ChatServices
>({
  name: operation === 'geminiGenerateContent' ? 'callGeminiGenerateContentUpstream' : 'callGeminiGenerateContentCountTokensUpstream',
  into: {
    request: {
      needs: ['request.chat.geminiGenerateContent', 'route.attempt', 'ingress.http.headers'],
      consumes: [],
      provides: ['request.provider.model', 'request.provider.payload', 'request.http.callId', 'request.http.headers'],
    },
    response: {
      needs: ['response.http.exchange', 'response.provider.output', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls', 'response.http.body'],
      consumes: ['response.http.exchange', 'response.provider.output', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls'],
      provides: ['response.chat.geminiGenerateContent', 'response.usage.billable', 'response.http.headers', 'response.http.status', 'response.http.body'],
    },
  },
  execute: async (facts, next, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    const requested = facts['request.chat.geminiGenerateContent'];
    const generates = operation === 'geminiGenerateContent';
    const payload = generates && candidate.rules !== undefined ? applyRulesToUpstreamGeminiGenerateContent(requested, candidate.rules) : requested;
    const pipeline = candidate.provider.pipelines[operation];
    if (pipeline === undefined) throw new Error(`Provider ${candidate.provider.kind} has no ${operation} pipeline`);
    const back = await next(providerEntry(facts, candidate, payload) as never, pipeline);
    const { 'response.http.exchange': _exchange, 'response.provider.output': _output,
      'response.provider.modelKey': _modelKey, 'response.provider.called': _called,
      'response.provider.previousCalls': _previousCalls, ...rest } = back;
    const reply = await providerChatAnswer(candidate, back as ProviderChatResponse<O>, use.gateway.abortSignal);
    if (generates && 'kind' in reply.answer) use.selectAffinity(candidate);
    return move({
      ...rest,
      'response.chat.geminiGenerateContent': reply.answer,
      'response.usage.billable': generates ? reply.billable : [],
      'response.http.headers': reply.headers,
      'response.http.status': reply.status,
      'response.http.body': reply.body,
    });
  },
});
