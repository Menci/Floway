import { wrapGeminiGenerateContentAffinityEgress } from './affinity/egress.ts';
import {
  geminiGenerateContentInternalErrorPayload,
  googleRpcHttpStatusCode,
  isGeminiGenerateContentErrorResponse,
} from './errors.ts';
import {
  encodeManagedSseStream,
  forwardedResponseHeaderEntries,
  gatewayJsonOutcome,
  serializeSseFrame,
  type DownstreamHttpOutcome,
} from '../../pipeline/index.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import {
  jsonResponseHeadersFromChatHttp,
  observeChatManagedStream,
  settleChatManagedSse,
  type ChatAttemptOutcome,
  type ChatPipelineServices,
  type ChatPlainOutcome,
} from '../pipeline/index.ts';
import type { StageEnv } from '@floway-dev/pipeline';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import {
  GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE,
  collectGeminiGenerateContentProtocolEventsToResult,
  createGeminiGenerateContentCandidateCompletion,
  geminiGenerateContentProtocolFrameToSSEFrame,
  isGeminiGenerateContentErrorEvent,
  isGeminiGenerateContentTerminalEvent,
  type GeminiGenerateContentErrorResponse,
  type GeminiGenerateContentStreamEvent,
} from '@floway-dev/protocols/gemini-generate-content';
import { toInternalDebugError } from '@floway-dev/provider';

const caughtGeminiGenerateContentErrorEvent = (error: unknown): GeminiGenerateContentErrorResponse | null => {
  if (!(error instanceof Error)) return null;
  return isGeminiGenerateContentErrorResponse(error.cause) ? error.cause : null;
};

const geminiSseTerminal = (
  frame: ProtocolFrame<GeminiGenerateContentStreamEvent>,
): 'completed' | 'protocol-error' | undefined => {
  if (frame.type === 'done') return 'completed';
  if (isGeminiGenerateContentErrorEvent(frame.event)) return 'protocol-error';
  if (isGeminiGenerateContentTerminalEvent(frame.event)) return 'completed';
  return undefined;
};

export const respondGeminiGenerateContentOutcome = async (
  outcome: ChatAttemptOutcome<GeminiGenerateContentStreamEvent>,
  wantsStream: boolean,
  env: StageEnv<ChatPipelineServices>,
): Promise<DownstreamHttpOutcome> => {
  if (outcome.type === 'api-error') {
    recordFailedRequest(env.ctx, outcome.performance);
    env.attribution.recordError(outcome.source, outcome.upstreamId);
    return {
      status: outcome.http.status,
      ...(outcome.http.statusText === undefined ? {} : { statusText: outcome.http.statusText }),
      headers: forwardedResponseHeaderEntries(outcome.http.headers, null),
      body: outcome.body,
    };
  }
  if (outcome.type === 'internal-error') {
    recordFailedRequest(env.ctx, outcome.performance);
    env.attribution.recordFailure(outcome.error);
    return gatewayJsonOutcome(
      outcome.http.status,
      geminiGenerateContentInternalErrorPayload(outcome.http.status, outcome.error),
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

  const observed = observeChatManagedStream(
    env,
    outcome.events,
    undefined,
    'downstream.protocol.events',
  );

  if (!wantsStream) {
    try {
      const response = await collectGeminiGenerateContentProtocolEventsToResult(
        wrapGeminiGenerateContentAffinityEgress(observed, env.affinity.egressOptions()),
      );
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
      const geminiError = caughtGeminiGenerateContentErrorEvent(error);
      return geminiError !== null
        ? gatewayJsonOutcome(googleRpcHttpStatusCode(geminiError.error.code), geminiError)
        : gatewayJsonOutcome(502, geminiGenerateContentInternalErrorPayload(502, toInternalDebugError(error)));
    }
  }

  const completion = createGeminiGenerateContentCandidateCompletion();
  let upstreamTerminal: 'completed' | 'protocol-error' | undefined;
  const observedUntilTerminal = env.wrapStream<ProtocolFrame<GeminiGenerateContentStreamEvent>, ProtocolFrame<GeminiGenerateContentStreamEvent>>(observed, {
    label: 'gemini-generate-content.upstream-terminal',
    async *transform(source) {
      for await (const frame of source) {
        upstreamTerminal = geminiSseTerminal(frame);
        if (frame.type === 'event' && upstreamTerminal === undefined) completion.observe(frame.event);
        yield frame;
        if (upstreamTerminal !== undefined) return;
      }
    },
  });
  const upstreamCompleted = (): boolean => upstreamTerminal === 'completed'
    || (upstreamTerminal === undefined && completion.isComplete());
  const events = env.wrapStream<ProtocolFrame<GeminiGenerateContentStreamEvent>, ProtocolFrame<GeminiGenerateContentStreamEvent>>(observedUntilTerminal, {
    label: 'downstream.protocol.events',
    transform: source => wrapGeminiGenerateContentAffinityEgress(source, env.affinity.egressOptions()),
  });
  const body = encodeManagedSseStream<ProtocolFrame<GeminiGenerateContentStreamEvent>>(env, events, {
    label: 'downstream.sse.bytes',
    protocol: {
      encode: frame => {
        const output = geminiGenerateContentProtocolFrameToSSEFrame(frame);
        const wire = output === null ? null : serializeSseFrame(output);
        const terminal = geminiSseTerminal(frame);
        return terminal === undefined ? { wire } : { wire, end: { type: terminal } };
      },
      eof: () => upstreamCompleted()
        ? { type: 'completed' }
        : { type: 'premature-eof', error: new Error(GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE) },
      failure: error => {
        const frame = eventFrame(caughtGeminiGenerateContentErrorEvent(error)
          ?? geminiGenerateContentInternalErrorPayload(500, toInternalDebugError(error)));
        env.attribution.recordFrame(frame);
        return [serializeSseFrame(geminiGenerateContentProtocolFrameToSSEFrame(frame)!)];
      },
    },
    onSettle: sseOutcome => settleChatManagedSse(
      env,
      outcome,
      sseOutcome.type === 'cancelled' && upstreamCompleted() ? { type: 'completed' } : sseOutcome,
    ),
  });
  return {
    status: outcome.http?.status ?? 200,
    ...(outcome.http?.statusText === undefined ? {} : { statusText: outcome.http.statusText }),
    headers: forwardedResponseHeaderEntries(outcome.http?.headers ?? [], 'text/event-stream'),
    body,
    sse: {},
  };
};

export const geminiGenerateContentCountOutcome = (
  outcome: ChatPlainOutcome,
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
