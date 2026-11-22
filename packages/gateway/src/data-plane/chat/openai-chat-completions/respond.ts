import { wrapOpenAIChatCompletionsAffinityEgress } from './affinity/egress.ts';
import {
  encodeManagedSseStream,
  forwardedResponseHeaderEntries,
  gatewayJsonOutcome,
  serializeSseFrame,
  type DownstreamHttpOutcome,
} from '../../pipeline/index.ts';
import { openaiInternalErrorPayload, openaiSseFailure } from '../../shared/openai-errors.ts';
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
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import {
  collectOpenAIChatCompletionsProtocolEventsToResult,
  openaiChatCompletionsErrorPayloadMessage,
  openaiChatCompletionsProtocolFrameToSSEFrame,
} from '@floway-dev/protocols/openai-chat-completions';
import { toInternalDebugError } from '@floway-dev/provider';

export interface OpenAIRespondOptions {
  readonly includeUsageChunk: boolean;
  readonly expectedChoices: number;
}

const apiErrorOutcome = (
  outcome: Extract<ChatAttemptOutcome<never>, { type: 'api-error' }>,
  env: StageEnv<ChatPipelineServices>,
): DownstreamHttpOutcome => {
  recordFailedRequest(env.ctx, outcome.performance);
  env.attribution.recordError(outcome.source, outcome.upstreamId);
  return {
    status: outcome.http.status,
    ...(outcome.http.statusText === undefined ? {} : { statusText: outcome.http.statusText }),
    headers: forwardedResponseHeaderEntries(outcome.http.headers, null),
    body: outcome.body,
  };
};

export const respondOpenAIChatCompletionsOutcome = async (
  outcome: ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  wantsStream: boolean,
  options: OpenAIRespondOptions,
  env: StageEnv<ChatPipelineServices>,
): Promise<DownstreamHttpOutcome> => {
  if (outcome.type === 'api-error') return apiErrorOutcome(outcome, env);

  if (outcome.type === 'internal-error') {
    recordFailedRequest(env.ctx, outcome.performance);
    env.attribution.recordFailure(outcome.error);
    return gatewayJsonOutcome(
      outcome.http.status,
      openaiInternalErrorPayload(outcome.error),
      forwardedResponseHeaderEntries(outcome.http.headers, 'application/json'),
    );
  }

  if (outcome.type === 'plain') {
    if (outcome.http.status >= 400) {
      env.attribution.recordError(outcome.upstreamId === undefined ? 'gateway' : 'upstream', outcome.upstreamId);
    }
    return {
      status: outcome.http.status,
      ...(outcome.http.statusText === undefined ? {} : { statusText: outcome.http.statusText }),
      headers: forwardedResponseHeaderEntries(outcome.http.headers, null),
      body: outcome.body,
    };
  }

  const events = observeChatManagedStream(
    env,
    outcome.events,
    source => wrapOpenAIChatCompletionsAffinityEgress(source, env.affinity.egressOptions()),
    'downstream.protocol.events',
  );
  if (!wantsStream) {
    try {
      const response = await collectOpenAIChatCompletionsProtocolEventsToResult(events);
      const meta = env.usageLedger.read(outcome.usageId, {
        modelIdentity: outcome.modelIdentity,
        performance: outcome.performance,
      });
      const usage = tokenUsageFromBillableUsage(meta.billableUsage);
      env.attribution.recordSuccess(meta.modelIdentity, usage);
      settle(env.ctx, meta.performance, meta.modelIdentity, usage, false);
      return {
        status: outcome.http?.status ?? 200,
        ...(outcome.http?.statusText === undefined ? {} : { statusText: outcome.http.statusText }),
        headers: jsonResponseHeadersFromChatHttp(outcome.http),
        body: new TextEncoder().encode(JSON.stringify(response)),
      };
    } catch (error) {
      recordFailedRequest(env.ctx, outcome.performance);
      env.attribution.recordFailure(error);
      return gatewayJsonOutcome(502, openaiInternalErrorPayload(toInternalDebugError(error)));
    }
  }

  const finishedChoices = new Set<number>();
  const body = encodeManagedSseStream<import('@floway-dev/protocols/common').ProtocolFrame<OpenAIChatCompletionsStreamEvent>>(env, events, {
    label: 'downstream.sse.bytes',
    protocol: {
      encode: frame => {
        const output = openaiChatCompletionsProtocolFrameToSSEFrame(frame, {
          includeUsageChunk: options.includeUsageChunk,
        });
        const wire = output === null ? null : serializeSseFrame(output);
        if (frame.type === 'done') return { wire, end: { type: 'completed' } };
        if (openaiChatCompletionsErrorPayloadMessage(frame.event) !== null) {
          return { wire, end: { type: 'protocol-error' } };
        }
        for (const { index, finish_reason: reason } of frame.event.choices) {
          if (reason !== null && reason !== undefined
            && Number.isInteger(index) && index >= 0 && index < options.expectedChoices) {
            finishedChoices.add(index);
          }
        }
        return { wire };
      },
      eof: () => finishedChoices.size === options.expectedChoices
        ? { type: 'completed' }
        : {
            type: 'premature-eof',
            error: new Error('OpenAI Chat Completions stream ended before all choices finished.'),
          },
      failure: error => openaiSseFailure(env.ctx, error),
    },
    onSettle: sseOutcome => settleChatManagedSse(env, outcome, sseOutcome),
  });
  return {
    status: outcome.http?.status ?? 200,
    ...(outcome.http?.statusText === undefined ? {} : { statusText: outcome.http.statusText }),
    headers: forwardedResponseHeaderEntries(outcome.http?.headers ?? [], 'text/event-stream'),
    body,
    sse: {},
  };
};
