import { wrapAnthropicMessagesAffinityEgress } from './affinity/egress.ts';
import { gatewayJsonOutcome, serializeSseFrame, type DownstreamHttpOutcome } from '../../pipeline/index.ts';
import { encodeManagedSseStream } from '../../pipeline/sse.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import {
  jsonResponseHeadersFromChatHttp,
  observeChatManagedStream,
  settleChatManagedSse,
  type ChatAttemptOutcome,
  type ChatPipelineServices,
} from '../pipeline/index.ts';
import type { StageEnv } from '@floway-dev/pipeline';
import {
  ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE,
  anthropicMessagesProtocolFrameToSSEFrame,
  collectAnthropicMessagesProtocolEventsToResult,
  type AnthropicMessagesStreamEventEx,
} from '@floway-dev/protocols/anthropic-messages';
import { sseFrame } from '@floway-dev/protocols/common';
import { internalDebugErrorFields, toInternalDebugError, type InternalDebugError } from '@floway-dev/provider';

export const internalAnthropicMessagesErrorPayload = (error: InternalDebugError) => ({
  type: 'error' as const,
  error: {
    type: error.type,
    message: error.message,
    provider_specific_fields: internalDebugErrorFields(error),
  },
});

export const renderAnthropicMessagesPipelineResponse = async (
  outcome: Extract<ChatAttemptOutcome<AnthropicMessagesStreamEventEx>, { type: 'events' }>,
  env: StageEnv<ChatPipelineServices>,
): Promise<DownstreamHttpOutcome> => {
  const observed = observeChatManagedStream(env, outcome.events);
  const affinity = env.wrapStream(observed, {
    label: 'anthropic-messages.affinity.events',
    transform: source => wrapAnthropicMessagesAffinityEgress(source, env.affinity.egressOptions()),
  });
  if (!env.chatCtx.wantsStream) {
    try {
      const response = await collectAnthropicMessagesProtocolEventsToResult(affinity);
      const meta = env.usageLedger.read(outcome.usageId, {
        modelIdentity: outcome.modelIdentity,
        ...(outcome.performance === undefined ? {} : { performance: outcome.performance }),
      });
      const usage = tokenUsageFromBillableUsage(meta.billableUsage);
      env.attribution.recordSuccess(meta.modelIdentity, usage);
      settle(env.ctx, meta.performance, meta.modelIdentity, usage, false);
      return {
        status: outcome.http?.status ?? 200,
        ...(outcome.http?.statusText === undefined ? {} : { statusText: outcome.http.statusText }),
        headers: jsonResponseHeadersFromChatHttp(outcome.http === undefined ? undefined : {
          ...outcome.http,
          headers: outcome.http.headers.filter(([name]) => name.toLowerCase() !== 'content-type'),
        }),
        body: new TextEncoder().encode(JSON.stringify(response)),
      };
    } catch (error) {
      recordFailedRequest(env.ctx, outcome.performance);
      env.attribution.recordFailure(error);
      return gatewayJsonOutcome(502, internalAnthropicMessagesErrorPayload(toInternalDebugError(error)));
    }
  }

  const body = encodeManagedSseStream(env, affinity, {
    label: 'anthropic-messages.sse.bytes',
    protocol: {
      encode: frame => {
        const output = anthropicMessagesProtocolFrameToSSEFrame(frame);
        const wire = output === null ? null : serializeSseFrame(output);
        if (frame.type === 'event') {
          if (frame.event.type === 'message_stop') return { wire, end: { type: 'completed' } };
          if (frame.event.type === 'error') return { wire, end: { type: 'protocol-error' } };
        }
        return { wire };
      },
      eof: () => ({ type: 'premature-eof', error: new Error(ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE) }),
      failure: error => {
        // Anthropic's SSE error body uses its Messages API error types.
        // https://github.com/anthropics/anthropic-sdk-typescript/blob/3f13f60335f8bcf91a782785f4f16e4267c999ad/src/resources/shared.ts#L247-L255
        const payload = internalAnthropicMessagesErrorPayload(toInternalDebugError(error));
        const event = { ...payload, error: { ...payload.error, type: 'api_error' } };
        return [serializeSseFrame(sseFrame(JSON.stringify(event), 'error'))];
      },
    },
    onSettle: settlement => settleChatManagedSse(env, outcome, settlement),
  });
  return {
    status: outcome.http?.status ?? 200,
    ...(outcome.http?.statusText === undefined ? {} : { statusText: outcome.http.statusText }),
    headers: jsonResponseHeadersFromChatHttp(outcome.http, [['content-type', 'text/event-stream']]),
    body,
    sse: { keepAliveWire: serializeSseFrame(sseFrame(JSON.stringify({ type: 'ping' }), 'ping')) },
  };
};
