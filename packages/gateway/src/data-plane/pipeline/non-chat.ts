import { edgeHttp, type HttpInput, type HttpOutput, jsonHttpResponse } from './edge-http.ts';
import { type AttemptResponse, type CandidateRequest, failover } from './failover.ts';
import type { GatewayHttpFacts } from './host.ts';
import { billableCall, emptyUsageFacts, observedTokenUsage, type ObservedUsage, observeIdentity, scalarUsageFacts, usageResponseKeys } from './observe-usage.ts';
import { type CandidateError, createResolveCandidates, type ModelRequest } from './resolve-candidates.ts';
import type { GatewayServices, RouteCandidate } from './services.ts';
import { priceUsage, type SettlementFacts, writeSettlement } from './settlement.ts';
import { filterInboundHeaderEntries } from '../shared/inbound-headers.ts';
import { type UsageMeasurement, tokenUsageMeasurement } from '../shared/telemetry/usage.ts';
import { isForwardableUpstreamHeader } from '../shared/upstream-response.ts';
import type { HeaderEntry, HttpRequestFacts, HttpResponseFacts } from '@floway-dev/http';
import { Bytes, compose, defineEnding, defineStage, type DynamicTarget, link, type Pipeline, type StageEnv } from '@floway-dev/pipeline';
import type { ModelKind } from '@floway-dev/protocols/common';
import { type PerformanceOperation, type ProviderHttpOutput, type ProviderInput, type ProviderPipelines, type ProviderServices, type TelemetryModelIdentity, toInternalDebugError } from '@floway-dev/provider';

export type ParsedOperation<Payload> = { readonly model: string; readonly payload: Payload } | { readonly error: string };

interface OperationRequest<Payload> extends ModelRequest, HttpInput {
  readonly 'request.payload': Payload;
}

interface NonChatPlan<Payload, Output extends ProviderHttpOutput> {
  readonly name: string;
  readonly sourceApi: string;
  readonly kind: ModelKind;
  readonly operation: PerformanceOperation;
  readonly parse: (http: HttpRequestFacts) => ParsedOperation<Payload> | Promise<ParsedOperation<Payload>>;
  readonly provider: (pipelines: ProviderPipelines) => Pipeline<ProviderInput<Payload>, Output, ProviderServices> | undefined;
  readonly providerExit?: readonly string[];
  readonly prepareProviderPayload?: (payload: Payload) => Payload;
  readonly select: (candidates: readonly RouteCandidate[], request: OperationRequest<Payload>) => readonly RouteCandidate[] | CandidateError;
  readonly unsupportedMessage?: (model: string) => string;
  readonly respond: (response: Output, request: OperationRequest<Payload> & CandidateRequest, identity: TelemetryModelIdentity, env: StageEnv) => AttemptResponse | Promise<AttemptResponse>;
}

const PROVIDER_ENTRY = ['provider.model', 'request.headers', 'request.payload'];
const PROVIDER_EXIT = ['response.http', 'response.modelKey'];

export const openAiApiError = (status: number, message: string, now: number): HttpResponseFacts =>
  jsonHttpResponse(status, { error: { message, type: 'api_error' } }, now);

export const invalidUpstreamResponse = (error: unknown, now: number): HttpResponseFacts =>
  jsonHttpResponse(502, { error: toInternalDebugError(error) }, now);

export const createNonChatPipeline = <Payload, ProviderOutput extends ProviderHttpOutput>(plan: NonChatPlan<Payload, ProviderOutput>) => {
  type Request = OperationRequest<Payload>;
  type Attempt = Request & CandidateRequest;
  type Targets = { provider: DynamicTarget<string, ProviderInput<Payload>, ProviderOutput, GatewayServices> };
  const providerExit = [...PROVIDER_EXIT, ...(plan.providerExit ?? [])];

  const parsePayload = defineStage<GatewayHttpFacts, Request, AttemptResponse, AttemptResponse>({
    name: 'parsePayload',
    through: {
      request: { needs: ['request.http'], consumes: [], provides: ['request.model', 'request.payload'] },
      response: { needs: [], consumes: [], provides: [] },
    },
    return: { provides: ['response.http', ...usageResponseKeys] },
    execute: async (facts, next, env) => {
      const request = await plan.parse(facts['request.http']);
      if ('error' in request) return { ...emptyUsageFacts(env), 'response.http': openAiApiError(400, request.error, env.clock()) };
      return await next({ ...facts, 'request.model': request.model, 'request.payload': request.payload });
    },
  });

  const enterUpstream = defineEnding<Attempt, AttemptResponse, Targets, Pick<GatewayServices, 'providers'>>({
    name: 'enterUpstream',
    request: { needs: ['request.http', 'request.payload', 'route.candidate'] },
    into: {
      provider: {
        request: { needs: [], consumes: ['request.http'], provides: ['provider.model', 'request.headers', ...(plan.prepareProviderPayload === undefined ? [] : ['request.payload'])] },
        response: { needs: providerExit, consumes: [], provides: ['response.http', 'response.attempt.status', ...usageResponseKeys] },
      },
    },
    execute: async (request, into, env) => {
      const { 'request.http': http, ...facts } = request;
      const candidate = facts['route.candidate'];
      const provider = env.services.providers.resolve(candidate.upstreamId);
      const result = await into.provider(candidate.upstreamId, {
        ...facts,
        'provider.model': candidate.providerModel,
        'request.headers': filterInboundHeaderEntries(http.headers, provider.inboundHeaderAllowlist),
        ...(plan.prepareProviderPayload === undefined ? {} : { 'request.payload': plan.prepareProviderPayload(facts['request.payload']) }),
      });
      const identity = observeIdentity(candidate, result['response.modelKey']);
      return { ...result, ...await plan.respond(result, request, identity, env), 'response.attempt.status': result['response.http'].status };
    },
  });

  const pipeline = compose<GatewayHttpFacts, HttpOutput & SettlementFacts, GatewayServices, Targets>(`${plan.name}.ingress`, {
    stages: [
      writeSettlement(plan.operation), priceUsage, edgeHttp, parsePayload,
      createResolveCandidates<RouteCandidate, Request>({
        kind: plan.kind, sourceApi: plan.sourceApi, select: plan.select, unsupportedMessage: plan.unsupportedMessage,
        requestNeeds: ['request.payload'],
      }),
      failover,
    ],
    targets: {
      provider: {
        entry: PROVIDER_ENTRY,
        exit: providerExit,
        resolve(upstreamId, { providers }) {
          const target = plan.provider(providers.resolve(upstreamId).pipelines);
          if (target === undefined) throw new Error(`Upstream ${upstreamId} has no pipeline for ${plan.sourceApi}`);
          return target;
        },
      },
    },
    ending: enterUpstream,
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

export const readHttpBytes = async (body: HttpResponseFacts['body']): Promise<Bytes> => {
  if (body === null) return Bytes.empty;
  if (body instanceof Bytes) return body;
  const chunks: Bytes[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Bytes.concat(chunks);
};

export const requestBytes = (request: HttpRequestFacts): Bytes => {
  if (request.body === null) return Bytes.empty;
  if (!(request.body instanceof Bytes)) throw new TypeError('Expected buffered request bytes');
  return request.body;
};

export const parseJsonModel = (http: HttpRequestFacts, requestName: string): ParsedOperation<Record<string, unknown>> => {
  const bytes = requestBytes(http);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.utf8());
  } catch {
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

export const scalarHttpAttempt = (env: StageEnv, http: HttpResponseFacts, identity: TelemetryModelIdentity, usage = observedTokenUsage(null)): AttemptResponse => ({
  ...scalarUsageFacts(env, billableCall(env, identity, httpSucceeded(http) ? 'completed' : 'api-error', usage)),
  'response.http': http,
});

export const respondJsonUsage = async (
  http: HttpResponseFacts, identity: TelemetryModelIdentity, env: StageEnv, sourceApi: string,
  extract: (body: unknown) => ReturnType<typeof tokenUsageMeasurement>['dumpTokenUsage'],
): Promise<AttemptResponse> => {
  const response = forwardHttp(http);
  if (!httpSucceeded(http)) return scalarHttpAttempt(env, response, identity);
  const bytes = await readHttpBytes(response.body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.utf8());
  } catch (error) {
    console.warn(`passthrough-serve: failed to parse 2xx upstream body for ${sourceApi}; usage row will be request-only`, error instanceof Error ? error.message : String(error));
  }
  const usage = parsed === undefined ? null : extract(parsed);
  return scalarHttpAttempt(env, { ...response, body: response.body === null ? null : bytes }, identity, measured(tokenUsageMeasurement(usage)));
};
