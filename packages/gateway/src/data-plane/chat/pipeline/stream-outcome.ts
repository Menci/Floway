import type { ChatAttemptOutcome, ChatHttpHead, ChatPipelineServices } from './types.ts';
import { failoverRouteCandidates, routeCandidateModelIdentity, routeCandidatePerformanceContext } from '../../pipeline/failover.ts';
import { firstOutputTokenSignal } from '../shared/first-output-token.ts';
import type { HeaderEntry, StageEnv } from '@floway-dev/pipeline';
import type { BillableUsage, ProtocolFrame } from '@floway-dev/protocols/common';
import { readManagedBytes } from '@floway-dev/provider';
import type {
  ChatTargetApi,
  HttpOutcome,
  InternalDebugError,
  PerformanceTelemetryContext,
  ProviderPipelineStreamOutcome,
  RouteCandidate,
} from '@floway-dev/provider';

export const isChatAttemptSuccess = (outcome: ChatAttemptOutcome<unknown>): boolean => {
  if (outcome.type === 'api-error' || outcome.type === 'internal-error') return false;
  const status = outcome.http?.status;
  return status === undefined || (status >= 200 && status < 300);
};

const chatHttpHead = (http: Pick<HttpOutcome, 'status' | 'statusText' | 'headers'>): ChatHttpHead => ({
  status: http.status,
  statusText: http.statusText,
  headers: Object.freeze([...http.headers]),
});

const withDefaultContentType = (headers: readonly HeaderEntry[]): readonly HeaderEntry[] => {
  if (headers.some(([name]) => name.toLowerCase() === 'content-type')) return Object.freeze([...headers]);
  return Object.freeze([...headers, Object.freeze(['content-type', 'application/json'] as const)]);
};

export const readUpstreamApiErrorFromHttpOutcome = async (
  http: HttpOutcome,
  upstreamId: string,
  performance?: PerformanceTelemetryContext,
): Promise<Extract<ChatAttemptOutcome<never>, { type: 'api-error' }>> => ({
  type: 'api-error',
  source: 'upstream',
  upstreamId,
  http: chatHttpHead(http),
  body: http.body === null ? null : await readManagedBytes(http.body),
  ...(performance === undefined ? {} : { performance }),
});

export const plainOutcomeFromHttpOutcome = async (
  http: HttpOutcome,
  upstreamId?: string,
): Promise<Extract<ChatAttemptOutcome<never>, { type: 'plain' }>> => ({
  type: 'plain',
  ...(upstreamId === undefined ? {} : { upstreamId }),
  http: {
    ...chatHttpHead(http),
    headers: withDefaultContentType(http.headers),
  },
  body: http.body === null ? null : await readManagedBytes(http.body),
});

export const providerStreamOutcomeToChatOutcome = async <TEvent>(
  providerOutcome: ProviderPipelineStreamOutcome<TEvent>,
  candidate: RouteCandidate,
  targetApi: ChatTargetApi,
  env: StageEnv<ChatPipelineServices>,
  readBillableUsage: (event: TEvent) => BillableUsage | null,
): Promise<ChatAttemptOutcome<TEvent>> => {
  const performanceContext = routeCandidatePerformanceContext(env, candidate, 'chat');
  if (!providerOutcome.ok) {
    return await readUpstreamApiErrorFromHttpOutcome(providerOutcome.http, candidate.upstreamId, performanceContext);
  }

  const modelIdentity = routeCandidateModelIdentity(candidate, providerOutcome.modelKey);
  const usageId = env.usageLedger.register({ modelIdentity, performance: performanceContext });
  const events = env.wrapStream<ProtocolFrame<TEvent>, ProtocolFrame<TEvent>>(providerOutcome.events, {
    label: `${targetApi}.metered.events`,
    async *transform(source) {
      for await (const frame of source) {
        if (env.attempt.timing.firstOutputTokenAt === null) {
          const signal = firstOutputTokenSignal(frame, targetApi);
          if (signal !== null) {
            env.attempt.timing.firstOutputTokenAt = performance.now();
            if (signal.type === 'runtime-output') {
              console.warn('Floway: first output timing started from runtime output without an earlier decode signal in this response', {
                outputType: signal.outputType,
                upstream: modelIdentity.upstream,
                model: modelIdentity.model,
                modelKey: modelIdentity.modelKey,
              });
            }
          }
        }
        if (frame.type === 'event') {
          const reported = readBillableUsage(frame.event);
          if (reported !== null) env.usageLedger.updateBillableUsage(usageId, reported);
        }
        yield frame;
      }
    },
  });

  return {
    type: 'events',
    events,
    modelIdentity,
    performance: performanceContext,
    http: chatHttpHead(providerOutcome.http),
    usageId,
  };
};

export const gatewayInputErrorOutcome = (
  status: number,
  body: unknown,
  performance?: PerformanceTelemetryContext,
): Extract<ChatAttemptOutcome<never>, { type: 'api-error' }> => ({
  type: 'api-error',
  source: 'gateway',
  http: {
    status,
    headers: Object.freeze([Object.freeze(['content-type', 'application/json'] as const)]),
  },
  body: new TextEncoder().encode(JSON.stringify(body)),
  ...(performance === undefined ? {} : { performance }),
});

export const openAiErrorChatOutcome = (
  status: number,
  message: string,
  extra?: { readonly param: string; readonly code: string | null },
  performance?: PerformanceTelemetryContext,
): Extract<ChatAttemptOutcome<never>, { type: 'api-error' }> =>
  gatewayInputErrorOutcome(
    status,
    { error: { message, type: 'invalid_request_error', ...extra } },
    performance,
  );

export const internalErrorChatOutcome = (
  status: number,
  error: InternalDebugError,
  performance?: PerformanceTelemetryContext,
): Extract<ChatAttemptOutcome<never>, { type: 'internal-error' }> => ({
  type: 'internal-error',
  http: {
    status,
    headers: Object.freeze([Object.freeze(['content-type', 'application/json'] as const)]),
  },
  error,
  ...(performance === undefined ? {} : { performance }),
});

export const failoverChatCandidates = async <TOutcome extends ChatAttemptOutcome<any>>(options: {
  readonly entries: ReadonlyArray<{ readonly candidate: RouteCandidate; readonly payload: any }>;
  readonly invocationLabel: string;
  readonly env: StageEnv<ChatPipelineServices>;
  readonly selectAffinityOnEvents?: boolean;
  readonly run: (entry: { readonly candidate: RouteCandidate; readonly payload: any }) => Promise<TOutcome>;
}): Promise<{ readonly candidate: RouteCandidate; readonly outcome: TOutcome }> => {
  const selected = await failoverRouteCandidates<{
    readonly candidate: RouteCandidate;
    readonly outcome: TOutcome;
  }>({
    candidates: options.entries.map(entry => entry.candidate),
    invocationLabel: options.invocationLabel,
    operation: 'chat',
    env: options.env,
    run: async candidate => {
      const entry = options.entries.find(item => item.candidate === candidate);
      if (entry === undefined) throw new Error('Failover invoked with a candidate outside the provided entries');
      return { candidate, outcome: await options.run(entry) };
    },
    inspect: result => {
      const outcome = result.outcome;
      return {
        success: isChatAttemptSuccess(outcome),
        ...(outcome.http === undefined ? {} : { headers: outcome.http.headers }),
        discardStream: outcome.type === 'events' && !isChatAttemptSuccess(outcome) ? outcome.events : null,
      };
    },
  });
  if (options.selectAffinityOnEvents !== false && selected.outcome.type === 'events') {
    options.env.affinity.select(selected.candidate);
  }
  return selected;
};
