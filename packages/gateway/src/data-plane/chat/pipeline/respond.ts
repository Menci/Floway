import { createChatPipelineServices, type ChatAttemptOutcome, type ChatHttpHead, type ChatPipelineServices } from './types.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { forwardedResponseHeaderEntries, inboundHeaderEntriesFromHeaders } from '../../pipeline/headers.ts';
import { runGatewayHttpPipeline, type DownstreamHttpOutcome, type RunGatewayHttpPipelineOptions, type SseOutcome } from '../../pipeline/index.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { recordSseOutcome, settle } from '../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { HeaderEntry, ManagedStream, Pipeline, StageEnv, WireRequestSnapshot } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';

export const providerModelsUnavailableOutcome = (
  error: unknown,
  env: StageEnv<ChatPipelineServices>,
): DownstreamHttpOutcome | null => {
  if (!(error instanceof ProviderModelsUnavailableError) || error.httpResponse === null) return null;
  env.attribution.recordError('upstream');
  return {
    status: error.httpResponse.status,
    headers: forwardedResponseHeaderEntries(inboundHeaderEntriesFromHeaders(error.httpResponse.headers), null),
    body: new TextEncoder().encode(error.httpResponse.body),
  };
};

export const createChatEdgeHttpStage = <FactsIn extends { readonly 'request.http': WireRequestSnapshot }>(options: {
  readonly name: string;
  readonly onThrow: (error: unknown, env: StageEnv<ChatPipelineServices>) => DownstreamHttpOutcome;
}) => defineStage<FactsIn, Record<never, never>, DownstreamHttpOutcome, DownstreamHttpOutcome, never, ChatPipelineServices>({
  name: options.name,
  tap: 'downstream',
  execute: async (_facts, next, env) => {
    try {
      return await next();
    } catch (error) {
      return options.onThrow(error, env);
    }
  },
});

export const runGatewayChatHttpPipeline = async <
  In extends { readonly 'request.http': WireRequestSnapshot },
>(
  c: AuthedContext,
  ctx: ChatGatewayCtx,
  pipe: Pipeline<In, DownstreamHttpOutcome, ChatPipelineServices>,
  input: In,
  options: RunGatewayHttpPipelineOptions<ChatPipelineServices> = {},
): Promise<Response> => await runGatewayHttpPipeline(c, ctx, pipe, input, {
  ...options,
  services: options.services ?? createChatPipelineServices(ctx),
});

export const chatApiErrorToDownstreamOutcome = (
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

export const chatPlainToDownstreamOutcome = (
  outcome: Extract<ChatAttemptOutcome<never>, { type: 'plain' }>,
  env: StageEnv<ChatPipelineServices>,
): DownstreamHttpOutcome => {
  if (outcome.http.status >= 400) {
    env.attribution.recordError(outcome.upstreamId === undefined ? 'gateway' : 'upstream', outcome.upstreamId);
  }
  return {
    status: outcome.http.status,
    ...(outcome.http.statusText === undefined ? {} : { statusText: outcome.http.statusText }),
    headers: forwardedResponseHeaderEntries(outcome.http.headers, null),
    body: outcome.body,
  };
};

export const observeChatManagedStream = <TEvent>(
  env: StageEnv<ChatPipelineServices>,
  events: ManagedStream<ProtocolFrame<TEvent>>,
  transform?: (source: AsyncIterable<ProtocolFrame<TEvent>>, signal: AbortSignal) => AsyncIterable<ProtocolFrame<TEvent>>,
  label = 'downstream.protocol.events',
): ManagedStream<ProtocolFrame<TEvent>> => env.wrapStream(events, {
  label,
  transform: (source, signal) => {
    const observed = (async function* () {
      for await (const frame of source) {
        env.attribution.recordFrame(frame);
        yield frame;
      }
    })();
    return transform === undefined ? observed : transform(observed, signal);
  },
});

export const settleChatManagedSse = <TEvent>(
  env: StageEnv<ChatPipelineServices>,
  chatOutcome: Extract<ChatAttemptOutcome<TEvent>, { type: 'events' }>,
  sseOutcome: SseOutcome,
): void => {
  const meta = env.usageLedger.read(chatOutcome.usageId, {
    modelIdentity: chatOutcome.modelIdentity,
    performance: chatOutcome.performance,
  });
  const usage = tokenUsageFromBillableUsage(meta.billableUsage);
  const failed = recordSseOutcome(env.ctx, sseOutcome, meta.modelIdentity, usage);
  settle(env.ctx, meta.performance, meta.modelIdentity, usage, failed);
};

export const jsonResponseHeadersFromChatHttp = (
  http: ChatHttpHead | undefined,
  extraHeaders: readonly HeaderEntry[] = [],
): readonly HeaderEntry[] => Object.freeze([
  ...forwardedResponseHeaderEntries(http?.headers ?? [], 'application/json'),
  ...extraHeaders,
]);
