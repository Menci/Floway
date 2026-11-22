import { type HttpInput, type HttpOutput, jsonHttpResponse } from './edge-http.ts';
import { createGatewayServices, type GatewayRouteFacts, type GatewayServices } from './services.ts';
import { isUpstreamTransportError } from '../../dial/transport-error.ts';
import { openDumpSession } from '../../dump/session.ts';
import { apiKeyFromContext, type AuthedContext, effectiveUpstreamIdsFromContext, userFromContext } from '../../middleware/auth.ts';
import type { ApiKey } from '../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import { writeHttpResponse } from '../shared/http-writer.ts';
import { httpUrl, type HttpRequestFacts, wrapSensitiveHeaderEntries } from '@floway-dev/http';
import { Bytes, type Pipeline, type RootEnv, run, type RunEventSink, type RunHandle, secret } from '@floway-dev/pipeline';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { toInternalDebugError } from '@floway-dev/provider';

const FINALIZATION_TIMEOUT_MS = 30_000;
const SECRET_QUERY_NAMES = new Set(['key', 'api_key', 'api-key', 'apikey', 'access_token', 'token', 'auth', 'sig', 'signature', 'session']);
const SECRET_AUTH_HEADERS = new Set(['x-goog-api-key', 'x-floway-session']);

export type GatewayHttpFacts = HttpInput & GatewayRouteFacts;

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
  readonly services: S;
  readonly scheduler: BackgroundScheduler;
  readonly signal?: AbortSignal;
  readonly events?: RunEventSink;
  readonly finalizationTimeoutMs?: number;
  readonly requestedModel?: string;
  readonly errorStatus?: (error: unknown) => 500 | 502;
}

export const startGatewayRun = <In, Out, S>(
  pipeline: Pipeline<In, Out, S>,
  input: In | ((root: RootEnv) => In),
  options: StartOptions<S>,
): RunHandle<Out> => {
  const dump = openDumpSession(options.apiKey, options.request, options.requestedModel);
  const events: RunEventSink | undefined = dump === null ? options.events : event => {
    dump.sink(event);
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
  if (dump !== null) {
    void handle.result.catch(error => dump.hostFailure(error, (options.errorStatus ?? gatewayErrorStatus)(error)));
    options.scheduler(dump.completed);
  }
  return handle;
};

export const gatewayErrorStatus = (error: unknown): 500 | 502 => isUpstreamTransportError(error) ? 502 : 500;

interface HttpOptions {
  readonly errorStatus?: StartOptions<GatewayServices>['errorStatus'];
  readonly errorBody?: (error: unknown) => unknown;
  readonly events?: RunEventSink;
}

export const createGatewayHttpHandler = <Out extends HttpOutput>(
  pipeline: Pipeline<GatewayHttpFacts, Out, GatewayServices>,
  options: HttpOptions = {},
) => async (c: AuthedContext): Promise<Response> => {
  try {
    const raw = c.req.raw;
    const host = gatewayHostContext(c);
    const request = httpRequestFacts(raw, raw.body === null ? null : Bytes.adopt(new Uint8Array(await raw.arrayBuffer())));
    const input = { ...host.route, 'request.http': request };
    const services = createGatewayServices({ apiKey: host.apiKey, scheduler: host.scheduler, runtimeLocation: host.route['request.route.runtimeLocation'] });
    const handle = startGatewayRun(pipeline, input, { ...options, ...host, request, services, signal: raw.signal });
    return writeHttpResponse((await handle.result)['response.http']);
  } catch (error) {
    const body = options.errorBody === undefined ? { error: toInternalDebugError(error) } : options.errorBody(error);
    return writeHttpResponse(jsonHttpResponse((options.errorStatus ?? gatewayErrorStatus)(error), body, 0));
  }
};
