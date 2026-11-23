import { billableCall, type CallPerformanceFacts, type CallUsageFacts, type ObservedCallPerformance, observedTokenUsage, type ObservedUsage, observeIdentity, priceCall, recordCall, scalarCallFacts, streamPerformance } from './call-metering.ts';
import { edgeHttp, type HttpDeliveryFacts, type HttpInput, type HttpOutput, jsonHttpResponse, stripFlowayAuth } from './edge-http.ts';
import { type CandidateRequest, createFailover } from './failover.ts';
import { GATEWAY_HTTP_ENTRY, type GatewayHttpFacts, isUploadError } from './host.ts';
import { localHttpAnswer, renderedNow, type RenderFacts, type RenderOutcome } from './render.ts';
import { type CandidateError, createResolveCandidates, type ModelRequest } from './resolve-candidates.ts';
import type { GatewayServices, RouteCandidate } from './services.ts';
import { createProviderEnding, type ProviderTargets } from '../chat/shared/enter-upstream.ts';
import { removeFact } from '../chat/shared/remove-fact.ts';
import { type UsageMeasurement, tokenUsageMeasurement } from '../shared/telemetry/usage.ts';
import { isForwardableUpstreamHeader } from '../shared/upstream-response.ts';
import { type HeaderEntry, type HttpRequestFacts, type HttpResponseFacts, isTransportFailure } from '@floway-dev/http';
import { Bytes, compose, defineEnding, defineStage, type ErrorSnapshot, type FactValue, isManagedStream, link, type Scope, type StaticTarget, type TargetMap } from '@floway-dev/pipeline';
import type { ModelKind } from '@floway-dev/protocols/common';
import { type HttpOutcome, type PerformanceOperation, type ProviderBaseOutput, type ProviderPipelines, readHttpBody, type TelemetryModelIdentity, toInternalDebugError } from '@floway-dev/provider';

export type ParsedOperation<Payload> = { readonly model: string; readonly payload: Payload } | { readonly error: string };
export type MeteredHttpResponse = HttpOutput & RenderFacts & CallUsageFacts & CallPerformanceFacts;

interface OperationRequest<Payload> extends ModelRequest, HttpInput {
  readonly 'request.payload': Payload;
}

type OutputOf<Targets extends TargetMap> = Targets[keyof Targets] extends StaticTarget<infer _Input, infer Output, infer _Services>
  ? Output : never;

type NonChatOperation = 'openaiCompletions' | 'openaiEmbeddings' | 'openaiImagesGenerations' | 'openaiImagesEdits'
  | 'openaiAudioTranscriptions' | 'rerank' | 'decision' | 'alphaSearch';
type OutcomeKey = `response.${NonChatOperation}`;
type PayloadFor<Key extends OutcomeKey> = Key extends `response.${infer Operation extends NonChatOperation}`
  ? NonNullable<ProviderPipelines[Operation]> extends StaticTarget<infer Input, infer _Output, infer _Services>
    ? Input extends { readonly 'request.payload': infer Payload } ? Payload : never
    : never
  : never;

type OperationResponse<Key extends OutcomeKey> = ProviderBaseOutput & Readonly<Record<Key, HttpOutcome>>;
type SuccessfulOutput<Key extends string, Targets extends TargetMap> = OutputOf<Targets>
  & ProviderBaseOutput & Readonly<Record<Key, Extract<OutputOf<Targets>[Key & keyof OutputOf<Targets>], { readonly kind: 'ok' }>>>;

interface NonChatPlan<Key extends OutcomeKey, Targets extends TargetMap<GatewayServices>, Payload = PayloadFor<Key>> {
  readonly name: string;
  readonly sourceApi: string;
  readonly kind: ModelKind;
  readonly operation: PerformanceOperation | null;
  readonly outcomeKey: Key;
  readonly targets: Targets & ProviderTargets<Payload, OperationResponse<Key>, {}>;
  readonly parse: (http: HttpRequestFacts) => ParsedOperation<Payload> | Promise<ParsedOperation<Payload>>;
  readonly prepareProviderPayload?: (payload: Payload) => Payload;
  readonly select: (candidates: readonly RouteCandidate[], request: OperationRequest<Payload>) => readonly RouteCandidate[] | CandidateError;
  readonly unsupportedMessage?: (model: string) => string;
  readonly respond: (response: SuccessfulOutput<Key, Targets>, request: OperationRequest<Payload> & CandidateRequest, identity: TelemetryModelIdentity, scope: Scope) => MeteredHttpResponse | Promise<MeteredHttpResponse>;
}

export const openAiApiError = (status: number, message: string, now: number): HttpResponseFacts =>
  jsonHttpResponse(status, { error: { message, type: 'api_error' } }, now);

export const invalidUpstreamResponse = (error: unknown, now: number): HttpResponseFacts =>
  jsonHttpResponse(502, { error: toInternalDebugError(error) }, now);

export const createNonChatPipeline = <const Key extends OutcomeKey, Targets extends TargetMap<GatewayServices>>(
  plan: NonChatPlan<Key, Targets>,
) => {
  type Payload = PayloadFor<Key>;
  type Request = GatewayHttpFacts & OperationRequest<Payload>;
  type Attempt = Request & CandidateRequest;
  type Response = OperationResponse<Key>;
  type Rendered = Response & RenderFacts;
  const { outcomeKey } = plan;
  const ingressExit = ['response.http', 'response.render', 'response.delivery'] as const;
  const httpRenderExit = ['response.http', 'response.render'] as const;
  const callEntry = [...GATEWAY_HTTP_ENTRY, 'request.model', 'request.payload', 'route.candidate'] as const;
  const upstreamExit = ['response.http', 'response.modelKey', outcomeKey] as const;
  const callExit = [...upstreamExit, 'response.render'] as const;

  const parsePayload = defineStage<GatewayHttpFacts, Request, HttpOutput & RenderFacts, HttpOutput & RenderFacts>({
    name: 'parsePayload',
    through: {
      request: { needs: ['request.http'], consumes: [], provides: ['request.model', 'request.payload'] },
      response: { needs: [], consumes: [], provides: [] },
    },
    return: { provides: httpRenderExit },
    execute: async (facts, scope) => {
      const http = facts['request.http'];
      if (isUploadError(http.body)) return localHttpAnswer(scope, invalidUpstreamResponse(new Error(http.body.error.message), scope.clock()));
      const parsed = await plan.parse(http);
      if ('error' in parsed) return localHttpAnswer(scope, openAiApiError(400, parsed.error, scope.clock()));
      return await scope.next({ ...facts, 'request.model': parsed.model, 'request.payload': parsed.payload });
    },
  });

  const observeHttpCall = defineStage<Attempt, Attempt, Response, Rendered & CallUsageFacts & CallPerformanceFacts>({
    name: 'observeHttpCall',
    through: {
      request: { needs: ['route.candidate', 'request.payload', 'request.model'], consumes: [], provides: [] },
      response: { needs: upstreamExit, consumes: [], provides: ['response.http', outcomeKey, 'response.render', 'response.call.usage', 'response.call.performance'] },
    },
    execute: async (facts, scope) => {
      const response = await scope.next(facts);
      const http = response['response.http'];
      const outcome = response[outcomeKey];
      if (outcome.kind === 'error') {
        return {
          ...response,
          ...renderedNow(scope, { kind: 'completed' }),
          ...scalarCallFacts(scope, null, outcome.source === 'upstream'
            ? { firstOutputAt: null, streamEndedAt: null, upstreamStartedAt: http.timing.startedAt, outputTokens: 0, failed: true }
            : null),
        };
      }
      const identity = observeIdentity(facts['route.candidate'], response['response.modelKey']);
      const rendered = await plan.respond(response as SuccessfulOutput<Key, Targets>, facts, identity, scope);
      const renderedHttp = rendered['response.http'];
      const observedHttp = renderedHttp.timing === http.timing ? renderedHttp : { ...renderedHttp, timing: http.timing };
      if (httpSucceeded(observedHttp)) return { ...response, ...rendered, 'response.http': observedHttp };
      if (!(observedHttp.body instanceof Bytes)) throw new TypeError('Expected buffered JSON for a rendered upstream error');
      return {
        ...response,
        ...rendered,
        'response.http': observedHttp,
        [outcomeKey]: { kind: 'error', source: 'upstream', error: JSON.parse(observedHttp.body.utf8()) as FactValue },
      };
    },
  });

  const call = compose<Attempt & OperationResponse<OutcomeKey> & RenderFacts, GatewayServices>()(`${plan.name}.egress`, {
    entry: callEntry,
    exit: callExit,
    stages: [recordCall(plan.operation), priceCall, observeHttpCall],
    targets: plan.targets,
    ending: createProviderEnding<Attempt, Payload, Response, {}>(
      outcomeKey,
      plan.targets,
      facts => {
        const payload = facts['request.payload'];
        return { 'request.payload': plan.prepareProviderPayload === undefined ? payload : plan.prepareProviderPayload(payload) };
      },
    ),
  });

  const encode = defineStage<Request, Request, Rendered, HttpOutput & RenderFacts>({
    name: 'encode',
    through: {
      request: { needs: [], consumes: [], provides: [] },
      response: { needs: callExit, consumes: ['response.modelKey', outcomeKey], provides: ['response.http'] },
    },
    execute: async (request, scope) => {
      const result = await scope.next(request);
      const outcome = result[outcomeKey];
      const withoutModel = removeFact<HttpOutput & RenderFacts & Readonly<Record<Key, HttpOutcome>>, 'response.modelKey'>(result, 'response.modelKey');
      const response = removeFact<HttpOutput & RenderFacts, Key>(withoutModel, outcomeKey);
      const http = response['response.http'];
      if (outcome.kind === 'ok' || http.body !== null) return response;
      const headers = forwardHttp(http).headers.filter(([name]) => name.toLowerCase() !== 'content-type');
      const body = Bytes.fromUtf8(JSON.stringify(outcome.error));
      return { ...response, 'response.http': { ...http, body, headers: [...headers, ['content-type', 'application/json']] } };
    },
  });

  const pipeline = compose<GatewayHttpFacts & HttpOutput & RenderFacts & HttpDeliveryFacts, GatewayServices>()(`${plan.name}.ingress`, {
    entry: GATEWAY_HTTP_ENTRY,
    exit: ingressExit,
    stages: [
      edgeHttp, stripFlowayAuth, parsePayload,
      createResolveCandidates<RouteCandidate, Request>({
        kind: plan.kind, sourceApi: plan.sourceApi, unsupportedMessage: plan.unsupportedMessage,
        select: (candidates, facts) => plan.select(candidates.filter(candidate => Object.hasOwn(plan.targets, candidate.kind)), facts),
        requestNeeds: ['request.payload'],
      }),
      encode, createFailover(outcomeKey),
    ],
    targets: { call },
    ending: defineEnding<Attempt, Rendered, { call: typeof call }, GatewayServices>({
      name: 'enterCall',
      request: { needs: callEntry },
      into: {
        call: {
          request: { needs: [], consumes: [], provides: [] },
          response: { needs: callExit, consumes: [], provides: [] },
        },
      },
      execute: async (facts, scope) => await scope.into.call(facts),
    }),
  });
  link([pipeline]);
  return pipeline;
};

export const header = (headers: readonly HeaderEntry[], name: string): string | undefined => {
  const entry = headers.find(([key]) => key.toLowerCase() === name)?.[1];
  return typeof entry === 'string' ? entry : entry?.reveal();
};

export const forwardHttp = (response: HttpResponseFacts, defaultContentType: string | null = 'application/json'): HttpResponseFacts => {
  const contentType = header(response.headers, 'content-type') ?? defaultContentType;
  const headers: HeaderEntry[] = response.headers.filter(([name]) => isForwardableUpstreamHeader(name));
  if (contentType !== null) headers.push(['content-type', contentType]);
  return { ...response, headers };
};

export { isUploadError } from './host.ts';

export const requestBytes = (request: HttpRequestFacts): Bytes => {
  if (request.body === null) return Bytes.empty;
  if (!(request.body instanceof Bytes)) throw new TypeError('Expected buffered request bytes');
  return request.body;
};

export const parseJsonModel = (http: HttpRequestFacts, requestName: string): ParsedOperation<Record<string, unknown>> => {
  if (isUploadError(http.body)) return { error: http.body.error.message };
  const bytes = requestBytes(http);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.utf8());
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { error: `${requestName} request body must be valid JSON.` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: `${requestName} request body must be an object.` };
  const { model, ...payload } = parsed as Record<string, unknown>;
  if (typeof model !== 'string' || model.length === 0) return { error: `${requestName} request body must include a model string.` };
  return { model, payload };
};

export const httpSucceeded = ({ status }: HttpResponseFacts): boolean => status >= 200 && status < 300;

export const measured = (measurement: UsageMeasurement): ObservedUsage => {
  const tokens = measurement.dumpTokenUsage;
  return {
    usage: tokens === null ? null : {
      input: tokens.input ?? 0, output: tokens.output ?? 0, cacheRead: tokens.input_cache_read ?? 0,
      cacheWrite: tokens.input_cache_write ?? 0, cacheWrite1h: tokens.input_cache_write_1h ?? 0,
      ...(tokens.tier == null ? {} : { tier: tokens.tier }),
    },
    pricingFacts: measurement.pricingFacts,
    measurement,
  };
};

export const scalarHttpAttempt = (
  scope: Pick<Scope, 'clock' | 'defer' | 'deferred' | 'wrapStream'>, http: HttpResponseFacts, identity: TelemetryModelIdentity, usage = observedTokenUsage(null), outcome: RenderOutcome = { kind: 'completed' },
): MeteredHttpResponse => {
  const failed = outcome.kind === 'failed' || !httpSucceeded(http);
  const call = httpSucceeded(http) || outcome.kind === 'failed' && outcome.reason === 'collect-error'
    || usage.usage !== null || Object.keys(usage.measurement?.quantities ?? {}).length > 0
    ? billableCall(scope, identity, failed ? 'stream-error' : 'completed', usage) : null;
  const sample = { firstOutputAt: null, upstreamStartedAt: http.timing.startedAt, outputTokens: usage.usage?.output ?? 0 };
  if (isManagedStream(http.body)) {
    let transport: ErrorSnapshot | undefined;
    const body = scope.wrapStream(http.body, {
      label: 'observed upstream body',
      async *transform(source) {
        for await (const chunk of source) {
          if (isTransportFailure(chunk)) transport = chunk.error;
          yield chunk;
        }
      },
      onClose: end => {
        performance.resolve(streamPerformance(end, failed || transport !== undefined, end.how === 'exhausted', {
          ...sample, streamEndedAt: scope.clock(),
        }));
      },
    });
    const performance = scope.deferred<ObservedCallPerformance | null>('call.performance', body);
    return {
      'response.http': { ...http, body },
      'response.call.usage': scope.defer('call.usage', Promise.resolve(call)),
      'response.call.performance': performance.deferred,
      ...renderedNow(scope, outcome),
    };
  }
  return {
    ...scalarCallFacts(scope, call, { ...sample, streamEndedAt: null, failed }),
    ...renderedNow(scope, outcome),
    'response.http': http,
  };
};

export const transportHttpAttempt = (
  scope: Pick<Scope, 'clock' | 'defer' | 'deferred' | 'wrapStream'>, http: HttpResponseFacts, identity: TelemetryModelIdentity, error: ErrorSnapshot,
): MeteredHttpResponse => {
  const status = 502;
  const response = { ...http, ...openAiApiError(status, error.message, scope.clock()), timing: http.timing, transportError: error };
  return scalarHttpAttempt(scope, response, identity, undefined, { kind: 'failed', reason: 'collect-error', error });
};

export const respondJsonUsage = async (
  http: HttpResponseFacts, identity: TelemetryModelIdentity, scope: Pick<Scope, 'clock' | 'defer' | 'deferred' | 'log' | 'wrapStream'>, sourceApi: string,
  extract: (body: unknown) => ReturnType<typeof tokenUsageMeasurement>['dumpTokenUsage'],
): Promise<MeteredHttpResponse> => {
  const response = forwardHttp(http);
  if (!httpSucceeded(http)) return scalarHttpAttempt(scope, response, identity);
  const body = await readHttpBody(response.body);
  if (!body.ok) return transportHttpAttempt(scope, response, identity, body.error);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.bytes.utf8());
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    scope.log.warn(`Failed to parse 2xx upstream body for ${sourceApi}; usage row will be request-only`, { message: error.message });
  }
  const usage = parsed === undefined ? null : extract(parsed);
  return scalarHttpAttempt(scope, { ...response, body: response.body === null ? null : body.bytes }, identity, measured(tokenUsageMeasurement(usage)));
};
