import { bodyForAttempt } from '../../../pipeline/attempt-body.ts';
import { providerEntry } from '../../../pipeline/provider-entry.ts';
import { upstreamPerformanceContext } from '../../../shared/telemetry/attribution.ts';
import type { ChatServices } from '../../services.ts';
import { applyRulesToUpstreamOpenAIResponses } from '../../shared/alias-rules.ts';
import { providerChatAnswer } from '../../shared/provider-answer.ts';
import type { Fields } from '../facts.ts';
import { syntheticEventsFromCompaction } from '../items/output.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ProviderOperationRequest, ProviderChatResponse } from '@floway-dev/provider';

export const callOpenAIResponsesCompactUpstream = defineStage<
  Fields<'request.chat.openaiResponses' | 'route.attempt' | 'ingress.http.headers'>,
  ProviderOperationRequest<'openaiResponsesCompact'>,
  ProviderChatResponse<'openaiResponsesCompact'>,
  Fields<'response.chat.openaiResponses' | 'response.usage.billable' | 'response.http.headers' | 'response.http.status' | 'response.http.body' | 'response.chat.openaiResponses.streamedUsage'>,
  ChatServices
>({
  name: 'callOpenAIResponsesCompactUpstream',
  into: {
    request: { needs: ['request.chat.openaiResponses', 'route.attempt', 'ingress.http.headers'], consumes: [], provides: ['request.provider.model', 'request.provider.payload', 'request.http.callId', 'request.http.headers'] },
    response: { needs: ['response.http.exchange', 'response.provider.output', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls', 'response.http.body'], consumes: ['response.http.exchange', 'response.provider.output', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls'], provides: ['response.chat.openaiResponses', 'response.usage.billable', 'response.http.headers', 'response.http.status', 'response.http.body', 'response.chat.openaiResponses.streamedUsage'] },
  },
  execute: async (facts, next, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'chat');
    const { stream: _stream, store: _store, ...body } = bodyForAttempt(facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload, candidate, applyRulesToUpstreamOpenAIResponses);
    const pipeline = candidate.provider.pipelines.openaiResponsesCompact;
    if (pipeline === undefined) throw new Error(`Provider ${candidate.provider.kind} has no openaiResponsesCompact pipeline`);
    const back = await next(providerEntry(facts, candidate, body), pipeline);
    const { 'response.http.exchange': _exchange, 'response.provider.output': _output, 'response.provider.modelKey': _modelKey, 'response.provider.called': _called, 'response.provider.previousCalls': _previousCalls, ...rest } = back;
    const reply = await providerChatAnswer(candidate, back);
    const answer = 'kind' in reply.answer && reply.answer.kind === 'value'
      ? { kind: 'stream' as const, frames: use.recordProtocolFrames(syntheticEventsFromCompaction(reply.answer.body as Parameters<typeof syntheticEventsFromCompaction>[0])) }
      : reply.answer;
    if ('kind' in answer) use.selectAffinity(candidate);
    return move({
      ...rest, 'response.chat.openaiResponses': answer,
      'response.usage.billable': reply.billable, 'response.http.headers': reply.headers,
      'response.http.status': reply.status, 'response.http.body': reply.body,
      'response.chat.openaiResponses.streamedUsage': null,
    });
  },
});
