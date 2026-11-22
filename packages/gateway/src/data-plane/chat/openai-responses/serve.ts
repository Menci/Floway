import { analyzeOpenAIResponsesAffinity } from './affinity/ingress.ts';
import { openaiResponsesAttemptPipeline, openaiResponsesTarget } from './attempt-pipeline.ts';
import { openaiResponsesCreatedAt, wrapOpenAIResponsesClientEgress, wrapOpenAIResponsesStatefulOutput } from './client-output.ts';
import { completeOpenAIResponsesCompaction } from './compaction-resource.ts';
import { renderOpenAIResponsesFailure, type OpenAIResponsesServeFailure } from './errors.ts';
import { hydrateOpenAIResponsesPayload } from './items/hydrate.ts';
import { syntheticEventsFromCompaction } from './items/output.ts';
import { OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE } from './response-headers.ts';
import { expandPreviousResponseId, PreviousResponseNotFoundError } from './serve-prep.ts';
import {
  encodeManagedSseStream,
  forwardedResponseHeaderEntries,
  gatewayJsonOutcome,
  serializeSseFrame,
  type DownstreamHttpOutcome,
  type SseProtocol,
} from '../../pipeline/index.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import {
  chatApiErrorToDownstreamOutcome,
  chatPlainToDownstreamOutcome,
  createChatEdgeHttpStage,
  failoverChatCandidates,
  providerModelsUnavailableOutcome,
  selectRouteAffinityCandidates,
  settleChatManagedSse,
  type ChatAttemptOutcome,
  type ChatPipelineServices,
} from '../pipeline/index.ts';
import { SourceStreamState } from '../pipeline/types.ts';
import { noViableCandidateFailure, tryCatchChatServeFailure } from '../shared/errors.ts';
import { serializeOpenAIResponsesStream, shouldSerializeStreamItems } from '../shared/stream-compatibility/index.ts';
import { defineStage, dispatch, handoff, pipeline } from '@floway-dev/pipeline';
import type { HeaderEntry, Pipeline, StageEnv, WireRequestSnapshot } from '@floway-dev/pipeline';
import { eventFrame, isJsonObject, sseFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import {
  collectOpenAIResponsesProtocolEventsToResult,
  isOpenAIResponsesErrorEvent,
  isOpenAIResponsesTerminalEvent,
  openaiResponsesProtocolFrameToSSEFrame,
  OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE,
  type CanonicalOpenAIResponsesPayload,
  type ClientOpenAIResponsesCompaction,
  type ClientOpenAIResponsesStreamEvent,
  type ClientResponseResource,
  type OpenAIResponsesErrorEx,
  type OpenAIResponsesStreamEventEx,
} from '@floway-dev/protocols/openai-responses';
import {
  internalDebugErrorFields,
  toInternalDebugError,
  type InternalDebugError,
  type RouteCandidate,
} from '@floway-dev/provider';

export const internalOpenAIResponsesErrorPayload = (error: InternalDebugError) => ({
  error: {
    type: error.type,
    message: error.message,
    provider_specific_fields: internalDebugErrorFields(error),
  },
});

export interface OpenAIResponsesPipelineInput {
  readonly 'request.http': WireRequestSnapshot;
  readonly 'request.inboundHeaders': readonly HeaderEntry[];
  readonly 'request.payload': CanonicalOpenAIResponsesPayload;
  readonly 'request.action': 'generate' | 'compact';
  readonly 'request.wantsStream': boolean;
  readonly 'request.userAgent'?: string;
}

interface PreparedFacts extends OpenAIResponsesPipelineInput {
  readonly 'route.candidates': readonly { readonly candidate: RouteCandidate; readonly payload: CanonicalOpenAIResponsesPayload }[];
}

interface AttemptFacts extends OpenAIResponsesPipelineInput {
  readonly 'route.candidate': RouteCandidate;
}

export type OpenAIResponsesTurnPreparation =
  | {
    readonly ok: true;
    readonly entries: readonly { readonly candidate: RouteCandidate; readonly payload: CanonicalOpenAIResponsesPayload }[];
    readonly payload: CanonicalOpenAIResponsesPayload;
  }
  | {
    readonly ok: false;
    readonly failure: Extract<ChatAttemptOutcome<never>, { type: 'api-error' }>;
  };

export const prepareOpenAIResponsesTurn = async (
  payload: CanonicalOpenAIResponsesPayload,
  env: StageEnv<ChatPipelineServices>,
): Promise<OpenAIResponsesTurnPreparation> => {
  const expanded = await expandPreviousResponseId(payload, env.store);
  const { candidates, sawModel, failedUpstreams } = await env.directory.enumerateCandidates(expanded.model, 'chat');
  const viable = candidates.filter(candidate => openaiResponsesTarget.canServe(candidate.endpoints));
  await env.store.loadInputItems(expanded.input, payload.input);
  let hydrated: CanonicalOpenAIResponsesPayload;
  try {
    hydrated = hydrateOpenAIResponsesPayload(expanded, env.store);
  } catch (error) {
    const failure = tryCatchChatServeFailure<OpenAIResponsesServeFailure>(error);
    if (failure === null) throw error;
    return { ok: false, failure: renderOpenAIResponsesFailure(failure) };
  }
  const affinity = await analyzeOpenAIResponsesAffinity(hydrated, env.affinity.codec);
  const selection = selectRouteAffinityCandidates(viable, affinity);
  if ('kind' in selection) {
    return { ok: false, failure: renderOpenAIResponsesFailure(selection) };
  }
  await env.store.stageInputItems(payload.input);
  if (selection.entries.length === 0) {
    return {
      ok: false,
      failure: renderOpenAIResponsesFailure(noViableCandidateFailure(sawModel, expanded.model, failedUpstreams)),
    };
  }
  return { ok: true, entries: selection.entries, payload: hydrated };
};

const prepare = defineStage<
  OpenAIResponsesPipelineInput,
  Pick<PreparedFacts, 'route.candidates' | 'request.payload'>,
  DownstreamHttpOutcome,
  DownstreamHttpOutcome,
  never,
  ChatPipelineServices
>({
  name: 'gateway.openai-responses.prepare',
  provides: ['route.candidates', 'request.payload'],
  execute: async (facts, next, env) => {
    const prepared = await prepareOpenAIResponsesTurn(facts['request.payload'], env);
    if (!prepared.ok) return chatApiErrorToDownstreamOutcome(prepared.failure, env);
    return await next({ 'route.candidates': prepared.entries, 'request.payload': prepared.payload });
  },
});

const failover = defineStage<
  PreparedFacts,
  Pick<AttemptFacts, 'route.candidate' | 'request.payload'>,
  ChatAttemptOutcome<OpenAIResponsesStreamEventEx>,
  DownstreamHttpOutcome,
  'route.candidates',
  ChatPipelineServices
>({
  name: 'gateway.openai-responses.failover',
  consumes: ['route.candidates'],
  provides: ['route.candidate', 'request.payload'],
  execute: async (facts, next, env) => {
    const selected = await failoverChatCandidates({
      entries: facts['route.candidates'],
      invocationLabel: `openaiResponsesServe.${facts['request.action']}`,
      env,
      run: entry => next({ 'route.candidate': entry.candidate, 'request.payload': entry.payload }),
    });
    return facts['request.action'] === 'compact'
      ? await respondOpenAIResponsesCompact(selected.outcome, env)
      : await respondOpenAIResponsesOutcome(
          selected.outcome,
          facts['request.wantsStream'],
          facts['request.payload'],
          facts['request.userAgent'],
          selected.candidate,
          env,
        );
  },
});

const failoverCompact = defineStage<
  PreparedFacts,
  Pick<AttemptFacts, 'route.candidate' | 'request.payload'>,
  ChatAttemptOutcome<OpenAIResponsesStreamEventEx>,
  DownstreamHttpOutcome,
  'route.candidates',
  ChatPipelineServices
>({
  name: 'gateway.openai-responses.compact.failover',
  consumes: ['route.candidates'],
  provides: ['route.candidate', 'request.payload'],
  execute: async (facts, next, env) => {
    const selected = await failoverChatCandidates({
      entries: facts['route.candidates'],
      invocationLabel: 'openaiResponsesServe.compact',
      env,
      run: entry => next({ 'route.candidate': entry.candidate, 'request.payload': entry.payload }),
    });
    return await respondOpenAIResponsesCompact(selected.outcome, env);
  },
});

const responsesEdgeOnThrow = (error: unknown, env: StageEnv<ChatPipelineServices>): DownstreamHttpOutcome => {
  const relayed = providerModelsUnavailableOutcome(error, env);
  if (relayed !== null) return relayed;
  if (error instanceof PreviousResponseNotFoundError) {
    env.attribution.recordError('gateway');
    return gatewayJsonOutcome(400, {
      error: {
        message: `Previous response with id '${error.previousResponseId}' not found.`,
        type: 'invalid_request_error',
        param: 'previous_response_id',
        code: 'previous_response_not_found',
      },
    });
  }
  recordFailedRequest(env.ctx, env.attempt.telemetry);
  env.attribution.recordFailure(error);
  return gatewayJsonOutcome(502, internalOpenAIResponsesErrorPayload(toInternalDebugError(error)));
};

export const openaiResponsesGeneratePipeline: Pipeline<
  OpenAIResponsesPipelineInput,
  DownstreamHttpOutcome,
  ChatPipelineServices
> = pipeline<OpenAIResponsesPipelineInput>('gateway.openai-responses.generate')
  .use(createChatEdgeHttpStage<OpenAIResponsesPipelineInput>({
    name: 'gateway.openai-responses.generate.edge',
    onThrow: responsesEdgeOnThrow,
  }))
  .use(prepare)
  .use(failover)
  .end(dispatch<AttemptFacts, ChatAttemptOutcome<OpenAIResponsesStreamEventEx>, ChatPipelineServices>({
    name: 'gateway.openai-responses.generate.dispatch',
    select: facts => handoff(openaiResponsesAttemptPipeline, {
      'route.candidate': facts['route.candidate'],
      'request.inboundHeaders': facts['request.inboundHeaders'],
      'request.payload': facts['request.payload'],
      'request.action': facts['request.action'],
    }),
  }));

export const openaiResponsesCompactPipeline: Pipeline<
  OpenAIResponsesPipelineInput,
  DownstreamHttpOutcome,
  ChatPipelineServices
> = pipeline<OpenAIResponsesPipelineInput>('gateway.openai-responses.compact')
  .use(createChatEdgeHttpStage<OpenAIResponsesPipelineInput>({
    name: 'gateway.openai-responses.compact.edge',
    onThrow: responsesEdgeOnThrow,
  }))
  .use(prepare)
  .use(failoverCompact)
  .end(dispatch<AttemptFacts, ChatAttemptOutcome<OpenAIResponsesStreamEventEx>, ChatPipelineServices>({
    name: 'gateway.openai-responses.compact.dispatch',
    select: facts => handoff(openaiResponsesAttemptPipeline, {
      'route.candidate': facts['route.candidate'],
      'request.inboundHeaders': facts['request.inboundHeaders'],
      'request.payload': facts['request.payload'],
      'request.action': facts['request.action'],
    }),
  }));

const ERROR_HTTP_STATUS = new Map<string, number>([
  ['invalid_request_error', 400],
  ['invalid_prompt', 400],
  ['authentication_error', 401],
  ['invalid_api_key', 401],
  ['permission_error', 403],
  ['not_found_error', 404],
  ['conflict_error', 409],
  ['unprocessable_entity_error', 422],
  ['rate_limit_error', 429],
  ['rate_limit_exceeded', 429],
  ['insufficient_quota', 429],
  ['server_error', 500],
  ['internal_error', 500],
]);

const numberOpenAIResponsesStream = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  serializeItems: boolean,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  if (serializeItems) {
    yield* serializeOpenAIResponsesStream(frames, true);
    return;
  }
  let sequence = 0;
  for await (const frame of frames) {
    if (frame.type === 'done') {
      yield frame;
      continue;
    }
    yield eventFrame({ ...frame.event, sequence_number: sequence++ });
  }
};

// OpenAI SDKs classify API failures by these HTTP categories.
// https://github.com/openai/openai-node/blob/b579bcb3e586d22269ffe6fe504653a0e05acbe8/src/core/error.ts#L60-L94
const errorHttpStatus = (event: Extract<OpenAIResponsesStreamEventEx, { type: 'error' }>): number => {
  const { type: _type, sequence_number: _sequenceNumber, ...fields } = event;
  const payload = ('error' in fields && isJsonObject(fields.error) ? fields.error : fields) as Readonly<Record<string, unknown>>;
  const details = isJsonObject(payload.provider_specific_fields) ? payload.provider_specific_fields : undefined;
  for (const classification of [payload.code, payload.type, details?.code, details?.type]) {
    if (typeof classification !== 'string') continue;
    const status = ERROR_HTTP_STATUS.get(classification);
    if (status !== undefined) return status;
  }
  return 502;
};

const observeOpenAIResponsesFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  state: SourceStreamState,
  _env: StageEnv<ChatPipelineServices>,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;
    const failed = frame.event.type === 'error' || frame.event.type === 'response.failed';
    if (failed) state.failed = true;
    yield frame;
    if (isOpenAIResponsesTerminalEvent(frame.event)) return;
  }
  if (state.failed) return;
  throw new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE);
};

const responsesSseProtocol = (
  _env: StageEnv<ChatPipelineServices>,
): SseProtocol<ProtocolFrame<ClientOpenAIResponsesStreamEvent>> => {
  let announced: ClientResponseResource | undefined;
  let upstreamFailure: OpenAIResponsesErrorEx | undefined;
  let nextSequence = 0;
  const completedItems = new Map<number, ClientResponseResource['output'][number]>();
  // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L82-L86
  const done = serializeSseFrame(sseFrame('[DONE]'));
  const emit = (event: ClientOpenAIResponsesStreamEvent): string => {
    const frame = eventFrame(event);
    nextSequence = Math.max(nextSequence, (event.sequence_number ?? nextSequence) + 1);
    const wire = serializeSseFrame(openaiResponsesProtocolFrameToSSEFrame(frame));
    return wire;
  };
  const failedTrailer = (failure: OpenAIResponsesErrorEx) => announced === undefined
    ? [done] as const
    : [emit({
        // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L419-L444
        type: 'response.failed',
        sequence_number: nextSequence++,
        response: {
          ...announced,
          status: 'failed',
          output: [...completedItems].sort(([left], [right]) => left - right).map(([, item]) => item),
          incomplete_details: null,
          error: failure,
        },
      }), done] as const;
  const eof: SseProtocol<ProtocolFrame<ClientOpenAIResponsesStreamEvent>>['eof'] = () => upstreamFailure === undefined
    ? { type: 'premature-eof', error: new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE) }
    : { type: 'protocol-error', trailer: failedTrailer(upstreamFailure) };
  return {
    encode: frame => {
      if (frame.type === 'done') return { wire: null, end: eof() };
      const event = { ...frame.event, sequence_number: frame.event.sequence_number ?? nextSequence };
      const wire = serializeSseFrame(openaiResponsesProtocolFrameToSSEFrame(eventFrame(event)));
      nextSequence = Math.max(nextSequence, event.sequence_number + 1);
      if ('response' in event) announced = event.response;
      if (event.type === 'response.output_item.done') completedItems.set(event.output_index, event.item);
      if (isOpenAIResponsesErrorEvent(event)) {
        const { type: _type, sequence_number: _sequence, ...fields } = event;
        const error = 'error' in fields ? fields.error : fields;
        // The stream error permits a null code; a failed Response requires a code.
        // https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/resources/responses/responses.ts
        upstreamFailure = { ...error, code: error.code ?? 'server_error' };
      }
      return isOpenAIResponsesTerminalEvent(event)
        ? { wire, end: { type: event.type === 'response.failed' || upstreamFailure !== undefined ? 'protocol-error' : 'completed', trailer: [done] } }
        : { wire };
    },
    eof,
    failure: error => {
      if (upstreamFailure !== undefined) return failedTrailer(upstreamFailure);
      const debug = toInternalDebugError(error);
      const failure: OpenAIResponsesErrorEx = {
        code: debug.type,
        message: debug.message,
        provider_specific_fields: internalDebugErrorFields(debug),
      };
      // SDKs raise on the nested payload; the Responses event also has native top-level fields.
      // https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/core/streaming.ts#L69-L71
      return [
        emit({ type: 'error', sequence_number: nextSequence++, code: failure.code, message: failure.message, param: null, error: failure }),
        ...failedTrailer(failure),
      ];
    },
  };
};

const respondOpenAIResponsesPreStreamFailure = (
  outcome: Exclude<ChatAttemptOutcome<OpenAIResponsesStreamEventEx>, { type: 'events' }>,
  env: StageEnv<ChatPipelineServices>,
): DownstreamHttpOutcome => {
  if (outcome.type === 'api-error') return chatApiErrorToDownstreamOutcome(outcome, env);
  if (outcome.type === 'plain') return chatPlainToDownstreamOutcome(outcome, env);
  recordFailedRequest(env.ctx, outcome.performance);
  env.attribution.recordFailure(outcome.error.message);
  return gatewayJsonOutcome(
    outcome.http.status,
    internalOpenAIResponsesErrorPayload(outcome.error),
    forwardedResponseHeaderEntries(outcome.http.headers, 'application/json'),
  );
};

const respondOpenAIResponsesOutcome = async (
  outcome: ChatAttemptOutcome<OpenAIResponsesStreamEventEx>,
  wantsStream: boolean,
  request: CanonicalOpenAIResponsesPayload,
  userAgent: string | undefined,
  candidate: RouteCandidate,
  env: StageEnv<ChatPipelineServices>,
): Promise<DownstreamHttpOutcome> => {
  if (outcome.type !== 'events') return respondOpenAIResponsesPreStreamFailure(outcome, env);

  const enabled = shouldSerializeStreamItems(
    new Set(candidate.providerModel.enabledFlags),
    'openaiResponses',
    userAgent ?? null,
  );
  const serialized = env.wrapStream(outcome.events, {
    label: 'openai-responses.serialized.events',
    transform: source => numberOpenAIResponsesStream(source, enabled),
  });

  if (!wantsStream) {
    const state = new SourceStreamState();
    const client = env.wrapStream(serialized, {
      label: 'openai-responses.client.events',
      transform: source => wrapOpenAIResponsesClientEgress(
        observeOpenAIResponsesFrames(source, state, env),
        env,
        request,
      ),
    });
    try {
      const response = await collectOpenAIResponsesProtocolEventsToResult(client);
      const meta = env.usageLedger.read(outcome.usageId, { modelIdentity: outcome.modelIdentity, performance: outcome.performance });
      const usage = tokenUsageFromBillableUsage(meta.billableUsage);
      env.attribution.recordSuccess(meta.modelIdentity, usage);
      settle(env.ctx, meta.performance, meta.modelIdentity, usage, state.failed || response.status === 'failed');
      return {
        status: outcome.http?.status ?? 200,
        ...(outcome.http?.statusText === undefined ? {} : { statusText: outcome.http.statusText }),
        headers: Object.freeze([
          ...forwardedResponseHeaderEntries(outcome.http?.headers ?? [], 'application/json'),
          Object.freeze([OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE] as const),
        ]),
        body: new TextEncoder().encode(JSON.stringify(response)),
      };
    } catch (error) {
      env.attribution.recordFailure(error);
      if (error instanceof Error && isOpenAIResponsesErrorEvent(error.cause)) {
        const meta = env.usageLedger.read(outcome.usageId, { modelIdentity: outcome.modelIdentity, performance: outcome.performance });
        const usage = tokenUsageFromBillableUsage(meta.billableUsage);
        env.attribution.recordSuccess(meta.modelIdentity, usage);
        settle(env.ctx, meta.performance, meta.modelIdentity, usage, true);
        const { sequence_number: _sequenceNumber, ...body } = error.cause;
        return gatewayJsonOutcome(errorHttpStatus(error.cause), body);
      }
      recordFailedRequest(env.ctx, outcome.performance);
      return gatewayJsonOutcome(502, internalOpenAIResponsesErrorPayload(toInternalDebugError(error)));
    }
  }

  const client = env.wrapStream(serialized, {
    label: 'openai-responses.client.events',
    transform: source => wrapOpenAIResponsesClientEgress(
      (async function* () {
        for await (const frame of source) {
          yield frame;
        }
      })(),
      env,
      request,
    ),
  });
  return {
    status: outcome.http?.status ?? 200,
    ...(outcome.http?.statusText === undefined ? {} : { statusText: outcome.http.statusText }),
    headers: Object.freeze([
      ...forwardedResponseHeaderEntries(outcome.http?.headers ?? [], 'text/event-stream'),
      Object.freeze([OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE] as const),
    ]),
    body: encodeManagedSseStream(env, client, {
      label: 'openai-responses.sse.bytes',
      protocol: responsesSseProtocol(env),
      onSettle: sseOutcome => settleChatManagedSse(env, outcome, sseOutcome),
    }),
    sse: {},
  };
};

const respondOpenAIResponsesCompact = async (
  outcome: ChatAttemptOutcome<OpenAIResponsesStreamEventEx>,
  env: StageEnv<ChatPipelineServices>,
): Promise<DownstreamHttpOutcome> => {
  if (outcome.type !== 'events') return respondOpenAIResponsesPreStreamFailure(outcome, env);
  try {
    const upstream = await collectOpenAIResponsesProtocolEventsToResult(outcome.events);
    const persisted = await collectOpenAIResponsesProtocolEventsToResult(
      wrapOpenAIResponsesStatefulOutput(syntheticEventsFromCompaction(upstream), env),
    );
    const result: ClientOpenAIResponsesCompaction = completeOpenAIResponsesCompaction(persisted, openaiResponsesCreatedAt(env.chatCtx));
    const meta = env.usageLedger.read(outcome.usageId, { modelIdentity: outcome.modelIdentity, performance: outcome.performance });
    const usage = tokenUsageFromBillableUsage(meta.billableUsage);
    const failed = upstream.status === 'failed';
    if (failed) env.attribution.recordFailure(upstream.error?.message ?? 'compact envelope status=failed');
    else env.attribution.recordSuccess(meta.modelIdentity, usage);
    settle(env.ctx, meta.performance, meta.modelIdentity, usage, failed);
    return {
      status: outcome.http?.status ?? 200,
      ...(outcome.http?.statusText === undefined ? {} : { statusText: outcome.http.statusText }),
      headers: forwardedResponseHeaderEntries(outcome.http?.headers ?? [], 'application/json'),
      body: new TextEncoder().encode(JSON.stringify(result)),
    };
  } catch (error) {
    env.attribution.recordFailure(error);
    if (error instanceof Error && isOpenAIResponsesErrorEvent(error.cause)) {
      const meta = env.usageLedger.read(outcome.usageId, { modelIdentity: outcome.modelIdentity, performance: outcome.performance });
      const usage = tokenUsageFromBillableUsage(meta.billableUsage);
      env.attribution.recordSuccess(meta.modelIdentity, usage);
      settle(env.ctx, meta.performance, meta.modelIdentity, usage, true);
      const { sequence_number: _sequenceNumber, ...body } = error.cause;
      return gatewayJsonOutcome(errorHttpStatus(error.cause), body);
    }
    recordFailedRequest(env.ctx, outcome.performance);
    return gatewayJsonOutcome(502, internalOpenAIResponsesErrorPayload(toInternalDebugError(error)));
  }
};
