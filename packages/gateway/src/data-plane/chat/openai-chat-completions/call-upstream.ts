import type { Fields } from './facts.ts';
import { bodyForAttempt } from '../../pipeline/attempt-body.ts';
import { providerEntry } from '../../pipeline/provider-entry.ts';
import { upstreamPerformanceContext } from '../../shared/telemetry/attribution.ts';
import type { ChatServices } from '../services.ts';
import { applyRulesToUpstreamOpenAIChatCompletions } from '../shared/alias-rules.ts';
import { providerChatAnswer } from '../shared/provider-answer.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProviderOperationRequest, ProviderChatResponse } from '@floway-dev/provider';

export const callOpenAIChatCompletionsUpstream = defineStage<
  Fields<'request.chat.openaiChatCompletions' | 'route.attempt' | 'ingress.http.headers'>,
  ProviderOperationRequest<'openaiChatCompletions'>,
  ProviderChatResponse<'openaiChatCompletions'>,
  Fields<'response.chat.openaiChatCompletions' | 'response.usage.billable' | 'response.http.headers' | 'response.http.status' | 'response.http.body'>,
  ChatServices
>({
  name: 'callOpenAIChatCompletionsUpstream',
  into: {
    request: { needs: ['request.chat.openaiChatCompletions', 'route.attempt', 'ingress.http.headers'], consumes: [], provides: ['request.provider.model', 'request.provider.payload', 'request.http.callId', 'request.http.headers'] },
    response: { needs: ['response.http.exchange', 'response.provider.output', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls', 'response.http.body'], consumes: ['response.http.exchange', 'response.provider.output', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls'], provides: ['response.chat.openaiChatCompletions', 'response.usage.billable', 'response.http.headers', 'response.http.status', 'response.http.body'] },
  },
  execute: async (facts, next, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'chat');
    const body = bodyForAttempt(facts['request.chat.openaiChatCompletions'], candidate, applyRulesToUpstreamOpenAIChatCompletions);
    const pipeline = candidate.provider.pipelines.openaiChatCompletions;
    if (pipeline === undefined) throw new Error(`Provider ${candidate.provider.kind} has no openaiChatCompletions pipeline`);
    const back = await next(providerEntry(facts, candidate, body), pipeline);
    const { 'response.http.exchange': _exchange, 'response.provider.output': _output, 'response.provider.modelKey': _modelKey, 'response.provider.called': _called, 'response.provider.previousCalls': _previousCalls, ...rest } = back;
    const reply = await providerChatAnswer(candidate, back);
    const answer = reply.answer;
    if ('kind' in answer) use.selectAffinity(candidate);
    return move({
      ...rest, 'response.chat.openaiChatCompletions': answer,
      'response.usage.billable': reply.billable, 'response.http.headers': reply.headers,
      'response.http.status': reply.status, 'response.http.body': reply.body,
    });
  },
});
