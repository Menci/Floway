import type { Fields } from './facts.ts';
import { bodyForAttempt } from '../../pipeline/attempt-body.ts';
import { providerEntry } from '../../pipeline/provider-entry.ts';
import { upstreamPerformanceContext } from '../../shared/telemetry/attribution.ts';
import type { ChatServices } from '../services.ts';
import { applyRulesToUpstreamAnthropicMessages } from '../shared/alias-rules.ts';
import { providerChatAnswer } from '../shared/provider-answer.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { parseAnthropicBetaHeader } from '@floway-dev/protocols/anthropic-messages';
import type { ProviderOperationRequest, ProviderChatResponse } from '@floway-dev/provider';

export const callAnthropicMessagesUpstream = defineStage<
  Fields<'request.chat.anthropicMessages' | 'route.attempt' | 'ingress.http.headers' | 'ingress.chat.sourceProtocol'>,
  ProviderOperationRequest<'anthropicMessages'>,
  ProviderChatResponse<'anthropicMessages'>,
  Fields<'response.chat.anthropicMessages' | 'response.usage.billable' | 'response.http.headers' | 'response.http.status' | 'response.http.body'>,
  ChatServices
>({
  name: 'callAnthropicMessagesUpstream',
  into: {
    request: { needs: ['request.chat.anthropicMessages', 'route.attempt', 'ingress.http.headers', 'ingress.chat.sourceProtocol'], consumes: [], provides: ['request.provider.model', 'request.provider.payload', 'request.http.callId', 'request.http.headers', 'request.provider.anthropicBeta'] },
    response: { needs: ['response.http.exchange', 'response.provider.output', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls', 'response.http.body'], consumes: ['response.http.exchange', 'response.provider.output', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls'], provides: ['response.chat.anthropicMessages', 'response.usage.billable', 'response.http.headers', 'response.http.status', 'response.http.body'] },
  },
  execute: async (facts, next, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'chat');
    const body = bodyForAttempt(facts['request.chat.anthropicMessages'], candidate, applyRulesToUpstreamAnthropicMessages);
    const headers = new Headers(facts['ingress.http.headers'].map(([name, value]): [string, string] => [name, value]));
    const anthropicBeta = facts['ingress.chat.sourceProtocol'] === 'anthropicMessages' ? parseAnthropicBetaHeader(headers.get('anthropic-beta')) : [];
    headers.delete('anthropic-beta');
    const pipeline = candidate.provider.pipelines.anthropicMessages;
    if (pipeline === undefined) throw new Error(`Provider ${candidate.provider.kind} has no anthropicMessages pipeline`);
    const back = await next(move({ ...providerEntry(facts, candidate, body, [...headers]), 'request.provider.anthropicBeta': anthropicBeta }), pipeline);
    const { 'response.http.exchange': _exchange, 'response.provider.output': _output, 'response.provider.modelKey': _modelKey, 'response.provider.called': _called, 'response.provider.previousCalls': _previousCalls, ...rest } = back;
    const reply = await providerChatAnswer(candidate, back);
    const answer = reply.answer;
    if ('kind' in answer) use.selectAffinity(candidate);
    return move({
      ...rest, 'response.chat.anthropicMessages': answer,
      'response.usage.billable': reply.billable, 'response.http.headers': reply.headers,
      'response.http.status': reply.status, 'response.http.body': reply.body,
    });
  },
});
