import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { StatusCode } from 'hono/utils/http-status';

import { forwardedResponseHeaderEntries, inboundHeaderEntriesFromHeaders, revealHeader } from './headers.ts';
import { createGatewayPipelineServices, type GatewayPipelineServices } from './services.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS, serializeSseFrame } from '../shared/sse.ts';
import { recordFailedRequest } from '../shared/telemetry/performance.ts';
import { defineStage, runPipeline, secret } from '@floway-dev/pipeline';
import type {
  HeaderEntry,
  ManagedStream,
  Pipeline,
  RunTraceSink,
  WireHttpUrl,
  WireRequestSnapshot,
} from '@floway-dev/pipeline';
import { sseCommentFrame } from '@floway-dev/protocols/common';
import { asyncIterableToReadableStream, ProviderModelsUnavailableError, toInternalDebugError } from '@floway-dev/provider';

export interface DownstreamHttpOutcome {
  readonly status: number;
  readonly statusText?: string;
  readonly headers: readonly HeaderEntry[];
  readonly body: ManagedStream<Uint8Array> | Uint8Array | null;
  readonly sse?: {
    readonly keepAliveIntervalMs?: number;
    readonly keepAliveWire?: string;
  };
}

export const SENSITIVE_URL_QUERY_NAMES: ReadonlySet<string> = new Set([
  'key',
  'api_key',
  'apikey',
  'access_token',
  'token',
  'auth',
  'sig',
  'signature',
  'session',
]);

export const buildDownstreamWireUrl = (rawUrl: string): WireHttpUrl => {
  const parsed = new URL(rawUrl);
  const query = [...parsed.searchParams.entries()].map(([name, value]) => Object.freeze([
    name,
    SENSITIVE_URL_QUERY_NAMES.has(name.toLowerCase()) ? secret(value) : value,
  ] as const));
  return Object.freeze({
    origin: parsed.origin,
    pathname: parsed.pathname,
    ...(query.length === 0 ? {} : { query: Object.freeze(query) }),
  });
};

const jsonBytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

export const gatewayJsonOutcome = (
  status: number,
  value: unknown,
  extraHeaders: readonly HeaderEntry[] = [],
): DownstreamHttpOutcome => {
  const hasContentType = extraHeaders.some(([name]) => name.toLowerCase() === 'content-type');
  return Object.freeze({
    status,
    headers: Object.freeze([
      ...extraHeaders,
      ...(hasContentType ? [] : [Object.freeze(['content-type', 'application/json'] as const)]),
    ]),
    body: jsonBytes(value),
  });
};

export const gatewayApiErrorOutcome = (message: string, status: number): DownstreamHttpOutcome =>
  gatewayJsonOutcome(status, { error: { message, type: 'api_error' } });

export const edgeHttpStage = <FactsIn extends { readonly 'request.http': WireRequestSnapshot }>(
  name = 'edge.downstream',
) => defineStage<FactsIn, Record<never, never>, DownstreamHttpOutcome, DownstreamHttpOutcome, never, GatewayPipelineServices>({
  name,
  tap: 'downstream',
  execute: async (_facts, next, env) => {
    try {
      return await next();
    } catch (error) {
      if (error instanceof ProviderModelsUnavailableError && error.httpResponse !== null) {
        env.attribution.recordError('upstream');
        return {
          status: error.httpResponse.status,
          headers: forwardedResponseHeaderEntries(inboundHeaderEntriesFromHeaders(error.httpResponse.headers), null),
          body: new TextEncoder().encode(error.httpResponse.body),
        };
      }
      recordFailedRequest(env.ctx, env.attempt.telemetry);
      env.attribution.recordFailure(error);
      return gatewayJsonOutcome(502, { error: toInternalDebugError(error) });
    }
  },
});

const headersWithoutContentType = (entries: readonly HeaderEntry[]): readonly HeaderEntry[] => Object.freeze(
  entries.filter(([name]) => name.toLowerCase() !== 'content-type'),
);

const stageHeaders = (c: Context, entries: readonly HeaderEntry[]): void => {
  for (const [name, value] of entries) c.header(name, revealHeader(value));
};

const streamSseBody = (
  c: Context,
  services: GatewayPipelineServices,
  outcome: DownstreamHttpOutcome,
  body: ManagedStream<Uint8Array>,
): Response => {
  if (outcome.sse === undefined) throw new Error('SSE materialization requires outcome.sse');
  const keepAliveIntervalMs = outcome.sse.keepAliveIntervalMs ?? DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS;
  if (!Number.isFinite(keepAliveIntervalMs) || keepAliveIntervalMs <= 0) {
    throw new Error('SSE keepalive interval must be a positive number');
  }
  const keepAliveWire = outcome.sse.keepAliveWire ?? serializeSseFrame(sseCommentFrame('keepalive'));
  c.status(outcome.status as StatusCode);
  stageHeaders(c, headersWithoutContentType(outcome.headers));
  const contentType = outcome.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  const upstreamContentType = contentType === undefined ? undefined : revealHeader(contentType);

  const response = streamSSE(c, async stream => {
    const abort = (reason?: unknown, egressFailure = false): void => {
      services.ctx.downstreamAbortController?.abort(reason);
      if (egressFailure) services.egressState.error ??= reason;
    };
    stream.onAbort(() => abort(new DOMException('Client disconnected', 'AbortError')));
    const iterator = body[Symbol.asyncIterator]();
    let wake: (() => void) | undefined;

    const read = async (): Promise<IteratorResult<Uint8Array> | undefined> => {
      const pending = iterator.next();
      let settled = false;
      const ready = (): void => {
        settled = true;
        wake?.();
      };
      void pending.then(ready, ready);
      while (!settled) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, keepAliveIntervalMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
        if (!settled && !stream.aborted && !stream.closed) {
          try {
            await stream.write(keepAliveWire);
          } catch (error) {
            abort(error, true);
            return undefined;
          }
        }
      }
      if (stream.aborted || stream.closed) return undefined;
      try {
        return await pending;
      } catch (error) {
        abort(error, true);
        return undefined;
      }
    };

    try {
      while (!stream.aborted && !stream.closed) {
        const next = await read();
        if (next === undefined || next.done) return;
        try {
          await stream.write(next.value);
        } catch (error) {
          abort(error, true);
          return;
        }
      }
    } finally {
      try {
        await iterator.return?.();
      } catch (error) {
        services.egressState.error ??= error;
      }
    }
  });
  if (upstreamContentType !== undefined) response.headers.set('content-type', upstreamContentType);
  return response;
};

export const materializeDownstreamResponse = (
  c: Context,
  services: GatewayPipelineServices,
  outcome: DownstreamHttpOutcome,
): Response => {
  services.attribution.status = outcome.status;
  if (outcome.sse !== undefined && outcome.body !== null && !(outcome.body instanceof Uint8Array)) {
    return streamSseBody(c, services, outcome, outcome.body);
  }

  const headers = new Headers();
  for (const [name, value] of outcome.headers) headers.append(name, revealHeader(value));
  const body = outcome.body === null
    ? null
    : outcome.body instanceof Uint8Array
      ? outcome.body as BodyInit
      : asyncIterableToReadableStream(outcome.body) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: outcome.status,
    ...(outcome.statusText === undefined ? {} : { statusText: outcome.statusText }),
    headers,
  });
};

export interface RunGatewayHttpPipelineOptions<
  Services extends GatewayPipelineServices = GatewayPipelineServices,
> {
  readonly traceSink?: RunTraceSink;
  readonly services?: Services;
}

export const runGatewayHttpPipeline = async <
  In extends { readonly 'request.http': WireRequestSnapshot },
  Services extends GatewayPipelineServices = GatewayPipelineServices,
>(
  c: AuthedContext,
  ctx: GatewayCtx,
  pipe: Pipeline<In, DownstreamHttpOutcome, Services>,
  input: In,
  ...[options]: GatewayPipelineServices extends Services
    ? [options?: RunGatewayHttpPipelineOptions<Services>]
    : [options: RunGatewayHttpPipelineOptions<Services> & { readonly services: Services }]
): Promise<Response> => {
  const resolvedServices = (options?.services ?? createGatewayPipelineServices(ctx)) as Services;
  const outcome = await runPipeline(pipe, input, {
    services: resolvedServices,
    signal: ctx.abortSignal,
    waitUntil: ctx.backgroundScheduler,
    ...(options?.traceSink === undefined ? {} : { traceSink: options.traceSink }),
  });
  const response = materializeDownstreamResponse(c, resolvedServices, outcome);
  return finalizeGatewayResponse(ctx, response);
};
