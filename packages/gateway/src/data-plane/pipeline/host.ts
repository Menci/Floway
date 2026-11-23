import { type HttpInput, type HttpOutput, jsonHttpResponse } from './edge-http.ts';
import { type BillableCall, mergeBillableCalls } from './observe-usage.ts';
import { createGatewayServices, type GatewayRouteFacts, type GatewayServices } from './services.ts';
import { persistBillableCalls, priceCalls } from './settlement.ts';
import { isUpstreamTransportError } from '../../dial/transport-error.ts';
import { openDumpSession } from '../../dump/session.ts';
import { apiKeyFromContext, type AuthedContext, effectiveUpstreamIdsFromContext, userFromContext } from '../../middleware/auth.ts';
import type { ApiKey } from '../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import { writeHttpResponse } from '../shared/http-writer.ts';
import { currentHour } from '../shared/telemetry/hour.ts';
import { providerModelsUnavailableResponse } from '../shared/upstream-response.ts';
import { httpUrl, type HttpRequestFacts, wrapSensitiveHeaderEntries } from '@floway-dev/http';
import { Bytes, type Deferred, type ErrorSnapshot, type Facts, isDeferred, type Pipeline, type RootEnv, run, type RunEvent, type RunEventSink, type RunHandle, secret, snapshotError } from '@floway-dev/pipeline';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { type PerformanceOperation, ProviderModelsUnavailableError, toInternalDebugError } from '@floway-dev/provider';

const FINALIZATION_TIMEOUT_MS = 30_000;
const SECRET_QUERY_NAMES = new Set(['key', 'api_key', 'api-key', 'apikey', 'access_token', 'token', 'auth', 'sig', 'signature', 'session']);
const SECRET_AUTH_HEADERS = new Set(['x-goog-api-key', 'x-floway-session']);

export type GatewayHttpFacts = HttpInput & GatewayRouteFacts & { readonly 'request.uploadError'?: ErrorSnapshot };

export const httpRequestFacts = (request: Request, body: Bytes | null, method = request.method): HttpRequestFacts => {
  const url = new URL(request.url);
  const sensitive = [...url.searchParams.keys()].filter(name => SECRET_QUERY_NAMES.has(name.toLowerCase()));
  return {
    method,
    url: httpUrl(url, sensitive),
    headers: wrapSensitiveHeaderEntries(Array.from(request.headers, ([name, value]) => [name, SECRET_AUTH_HEADERS.has(name) ? secret(value) : value])),
    body,
  };
};

export const gatewayHostContext = (c: AuthedContext, scheduler = backgroundSchedulerFromContext(c)) => {
  const apiKey = apiKeyFromContext(c);
  const { id, isAdmin } = userFromContext(c);
  const location = getRuntimeLocation(c.req.raw);
  return {
    apiKey,
    scheduler,
    route: {
      'request.auth.apiKeyId': apiKey.id,
      'request.auth.user': { id, isAdmin },
      'request.route.upstreamIds': effectiveUpstreamIdsFromContext(c),
      'request.route.randomizeUpstreams': apiKey.randomizeUpstreams,
      'request.route.runtimeLocation': location,
    } satisfies GatewayRouteFacts,
  };
};

interface StartOptions<S> {
  readonly apiKey: ApiKey;
  readonly request: HttpRequestFacts;
  readonly services: S & Partial<Pick<GatewayServices, 'usageStore'>>;
  readonly scheduler: BackgroundScheduler;
  readonly signal?: AbortSignal;
  readonly events?: RunEventSink;
  readonly finalizationTimeoutMs?: number;
  readonly requestedModel?: string;
  readonly errorStatus?: (error: unknown) => 500 | 502;
  readonly crashPerformance?: {
    readonly route: GatewayRouteFacts;
    readonly operation: PerformanceOperation;
    readonly store: GatewayServices['performanceStore'];
  };
}

interface CrashCandidate { readonly modelId: string; readonly upstreamId: string }

const crashCandidate = (facts: Facts): CrashCandidate | undefined => {
  const candidate = facts['route.candidate'];
  if (candidate === null || typeof candidate !== 'object'
    || !('modelId' in candidate) || typeof candidate.modelId !== 'string'
    || !('upstreamId' in candidate) || typeof candidate.upstreamId !== 'string') return undefined;
  return { modelId: candidate.modelId, upstreamId: candidate.upstreamId };
};

const observeRun = () => {
  const parents = new Map<number, number | null>();
  const billings = new Set<Deferred<readonly BillableCall[]>>();
  const settlements = new Set<Deferred<unknown>>();
  const covered = new Set<Deferred<readonly BillableCall[]>>();
  let crash: { readonly stageId: number; readonly candidate: CrashCandidate | undefined } | undefined;

  const isAncestor = (ancestor: number, stage: number): boolean => {
    for (let parent = parents.get(stage); parent != null; parent = parents.get(parent)) {
      if (parent === ancestor) return true;
    }
    return false;
  };

  const observe = (event: RunEvent): void => {
    switch (event.k) {
    case 'enter': parents.set(event.stageId, event.parentStageId); break;
    case 'fail': {
      if (crash === undefined || !isAncestor(event.stageId, crash.stageId)) {
        crash = { stageId: event.stageId, candidate: crashCandidate(event.facts) };
      } else if (crash.candidate === undefined) {
        crash = { ...crash, candidate: crashCandidate(event.facts) };
      }
      break;
    }
    case 'leave': {
      const billing = event.facts['response.usage.billable'];
      if (!isDeferred(billing)) break;
      const observed = billing as Deferred<readonly BillableCall[]>;
      billings.add(observed);
      const settlement = event.facts['response.settlement'];
      // The settlement takes responsibility even if finalization ends before its write returns.
      if (isDeferred(settlement) && !settlements.has(settlement)) {
        settlements.add(settlement);
        covered.add(observed);
      }
    }
    }
  };

  const sweep = async (keyId: string, usageStore: GatewayServices['usageStore']): Promise<void> => {
    if (billings.size === 0) return;
    const [calls, assigned] = await Promise.all([
      mergeBillableCalls([...billings]),
      mergeBillableCalls([...covered]),
    ]);
    const callIds = new Set(assigned.map(call => call.callId));
    await persistBillableCalls(priceCalls(calls.filter(call => !callIds.has(call.callId))), keyId, usageStore);
  };

  return { observe, sweep, candidate: () => crash?.candidate };
};

export const startGatewayRun = <In, Out, S>(
  pipeline: Pipeline<In, Out, S>,
  input: In | ((root: RootEnv) => In),
  options: StartOptions<S>,
): RunHandle<Out> => {
  const dump = openDumpSession(options.apiKey, options.request, options.requestedModel);
  const observed = observeRun();
  const events: RunEventSink = event => {
    observed.observe(event);
    dump?.sink(event);
    options.events?.(event);
  };
  const handle = run(pipeline, input, {
    services: options.services,
    signal: options.signal,
    events,
    finalizationTimeoutMs: options.finalizationTimeoutMs ?? FINALIZATION_TIMEOUT_MS,
    ...(dump === null ? {} : { runId: dump.recordId }),
  });
  options.scheduler(handle.done);
  const { usageStore } = options.services;
  if (usageStore !== undefined) options.scheduler(handle.done.then(() => observed.sweep(options.apiKey.id, usageStore)));
  if (dump !== null) options.scheduler(dump.completed);
  void handle.result.catch(error => {
    const candidate = observed.candidate();
    if (dump !== null) {
      const upstream = error instanceof ProviderModelsUnavailableError ? error.httpResponse : null;
      dump.hostFailure(error, upstream?.status ?? (options.errorStatus ?? gatewayErrorStatus)(error), upstream !== null, candidate);
    }
    const performance = options.crashPerformance;
    if (performance === undefined || candidate === undefined) return;
    options.scheduler(performance.store.record({
      kind: 'zero-output-error',
      dimensions: {
        hour: currentHour(),
        keyId: performance.route['request.auth.apiKeyId'],
        model: candidate.modelId,
        upstream: candidate.upstreamId,
        operation: performance.operation,
        runtimeLocation: performance.route['request.route.runtimeLocation'],
      },
    }).catch(cause => console.warn('Failed to record performance zero-output-error:', cause)));
  });
  return handle;
};

export const gatewayErrorStatus = (error: unknown): 500 | 502 => isUpstreamTransportError(error) ? 502 : 500;

interface HttpOptions {
  readonly errorStatus?: StartOptions<GatewayServices>['errorStatus'];
  readonly errorBody?: (error: unknown) => unknown;
  readonly events?: RunEventSink;
  readonly performanceOperation?: PerformanceOperation;
}

const readUpload = async (raw: Request): Promise<{ readonly body: Bytes | null; readonly error?: ErrorSnapshot }> => {
  if (raw.body === null) return { body: null };
  let bytes: ArrayBuffer;
  try {
    bytes = await raw.arrayBuffer();
  } catch (error) {
    return { body: Bytes.empty, error: snapshotError(error) };
  }
  return { body: Bytes.adopt(new Uint8Array(bytes)) };
};

export const createGatewayHttpHandler = <Out extends HttpOutput>(
  pipeline: Pipeline<GatewayHttpFacts, Out, GatewayServices>,
  options: HttpOptions = {},
) => async (c: AuthedContext): Promise<Response> => {
  try {
    const raw = c.req.raw;
    const host = gatewayHostContext(c);
    const upload = await readUpload(raw);
    const request = httpRequestFacts(raw, upload.body);
    const input = { ...host.route, 'request.http': request, ...(upload.error === undefined ? {} : { 'request.uploadError': upload.error }) };
    const services = createGatewayServices({ apiKey: host.apiKey, scheduler: host.scheduler, runtimeLocation: host.route['request.route.runtimeLocation'] });
    const crashPerformance = options.performanceOperation === undefined ? undefined : {
      route: host.route, operation: options.performanceOperation, store: services.performanceStore,
    };
    const handle = startGatewayRun(pipeline, input, {
      ...options, ...host, request, services, crashPerformance,
      ...(upload.error === undefined ? { signal: raw.signal } : {}),
    });
    return writeHttpResponse((await handle.result)['response.http']);
  } catch (error) {
    const upstreamResponse = providerModelsUnavailableResponse(error);
    if (upstreamResponse !== null) return upstreamResponse;
    const body = options.errorBody === undefined ? { error: toInternalDebugError(error) } : options.errorBody(error);
    return writeHttpResponse(jsonHttpResponse((options.errorStatus ?? gatewayErrorStatus)(error), body, 0));
  }
};
