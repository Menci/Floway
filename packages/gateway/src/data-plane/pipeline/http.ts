import { openRequestArchive } from './archive.ts';
import type { UsageObservation } from './compute-usage.ts';
import type { GatewayPipelineFacts, ResponseOutcome } from './facts.ts';
import { createGatewayServices, type GatewayServices } from './services.ts';
import { apiKeyFromContext, type AuthedContext, userFromContext } from '../../middleware/auth.ts';
import { internalErrorResponse } from '../../middleware/internal-error-response.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import { isForwardableUpstreamHeader } from '../shared/upstream-response.ts';
import type { HttpRequestFact, HttpResponseFact } from '@floway-dev/http';
import { run, type Pipeline } from '@floway-dev/pipeline';

type HttpEntry = Pick<GatewayPipelineFacts,
  | 'request.http'
  | 'request.auth.apiKeyId'
  | 'request.auth.userId'
  | 'request.auth.isAdmin'
  | 'request.auth.upstreamIds'
  | 'request.auth.randomizeUpstreams'
  | 'serve.startedAt'
  | 'serve.runtimeLocation'
>;
type HttpAnswer = Pick<GatewayPipelineFacts, 'response.http'> & Partial<Pick<GatewayPipelineFacts,
  'response.candidate' | 'response.usage' | 'response.performance' | 'response.outcome' | 'response.requestedModel'
>>;

export const httpRequestFact = async (request: Request): Promise<HttpRequestFact> => {
  const url = new URL(request.url);
  if (url.searchParams.has('key')) {
    url.search = url.search.slice(1).split('&').filter(field => !new URLSearchParams(field).has('key')).join('&');
  }
  return {
    url: url.href,
    method: request.method,
    headers: [...request.headers],
    body: request.body === null ? null : new Uint8Array(await request.arrayBuffer()),
  };
};

const responseHeaders = (http: HttpResponseFact): Headers => {
  const headers = new Headers();
  for (const [name, value] of http.headers) {
    if (name.toLowerCase() !== 'content-type' && !isForwardableUpstreamHeader(name)) continue;
    if (typeof value !== 'string') throw new TypeError(`Secret response header ${name} cannot be sent to a client`);
    headers.append(name, value);
  }
  return headers;
};

const panicError = (error: unknown): Error => error instanceof Error ? error : new Error('Floway pipeline panicked', { cause: error });

export const serveHttp = (pipeline: Pipeline<HttpEntry, HttpAnswer, GatewayServices>) =>
  async (c: AuthedContext): Promise<Response> => {
    const startedAt = Date.now();
    const request = c.req.raw;
    const apiKey = apiKeyFromContext(c);
    const user = userFromContext(c);
    const waitUntil = backgroundSchedulerFromContext(c);
    const runtimeLocation = getRuntimeLocation(request);
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    let responseBytes = 0;
    let answer: HttpAnswer | undefined;
    let usage: Promise<UsageObservation | undefined> = Promise.resolve(undefined);
    let performance: Promise<{ ttftMs: number | null } | undefined> = Promise.resolve(undefined);
    let outcome: Promise<ResponseOutcome | undefined> = Promise.resolve(undefined);
    let archive: ReturnType<typeof openRequestArchive> | undefined;
    let discardBody: (() => void) | undefined;
    const complete = (status: number, error?: unknown): void => {
      controller.abort(error);
      archive?.complete({
        status,
        responseBytes,
        candidate: answer?.['response.candidate'],
        requestedModel: answer?.['response.requestedModel'],
        usage,
        performance,
        outcome,
        error,
      });
    };

    try {
      const [http, services] = await Promise.all([httpRequestFact(request), createGatewayServices(runtimeLocation, apiKey)]);
      if (apiKey.dumpRetentionSeconds !== null) archive = openRequestArchive(apiKey.id, http, startedAt, waitUntil);
      const running = run(pipeline, {
        'request.http': http,
        'request.auth.apiKeyId': apiKey.id,
        'request.auth.userId': user.id,
        'request.auth.isAdmin': user.isAdmin,
        'request.auth.upstreamIds': apiKey.upstreamIds,
        'request.auth.randomizeUpstreams': apiKey.randomizeUpstreams,
        'serve.startedAt': startedAt,
        'serve.runtimeLocation': runtimeLocation,
      }, {
        services,
        signal,
        waitUntil: archive?.waitUntil ?? waitUntil,
        ...(archive === undefined ? {} : { events: archive.events }),
      });
      archive?.finish(running.done);
      answer = await running.result;
      const observation = answer['response.usage'];
      if (observation) {
        usage = running.read(observation);
        void usage.catch(() => undefined);
      }
      const measure = answer['response.performance'];
      if (measure) {
        performance = running.read(measure);
        void performance.catch(() => undefined);
      }
      const verdict = answer['response.outcome'];
      if (verdict) {
        outcome = running.read(verdict);
        void outcome.catch(() => undefined);
      }
      const response = answer['response.http'];
      if (response === null) throw new Error('The HTTP ingress returned without rendering its response');
      const { status, statusText, body } = response;
      if (body !== null && !(body instanceof Uint8Array)) discardBody = () => running.discard(body);
      const headers = responseHeaders(response);
      if (body === null || body instanceof Uint8Array) {
        controller.abort();
        await running.done;
        responseBytes = body?.byteLength ?? 0;
        const clientResponse = new Response(body as Uint8Array<ArrayBuffer> | null, { status, statusText, headers });
        complete(status);
        return clientResponse;
      }

      const reader = running.read(body);
      let bodyReleased = false;
      let stopped = false;
      let pending: Promise<void> | undefined;
      const releaseBody = async (): Promise<void> => {
        await pending;
        if (!bodyReleased) running.discard(body);
      };
      const onPanic = (output: ReadableStreamDefaultController<Uint8Array>, error: unknown): void => {
        if (stopped) return;
        stopped = true;
        const panic = panicError(error);
        complete(status, panic);
        console.error(panic);
        output.error(panic);
      };
      const bytes = new ReadableStream<Uint8Array>({
        start(output) {
          void running.done.catch(error => {
            if (bodyReleased || stopped) return;
            onPanic(output, error);
            waitUntil(releaseBody());
          });
        },
        pull(output) {
          pending = (async () => {
            try {
              const frame = await reader.next();
              if (!frame.done) {
                if (stopped) return;
                if (frame.value.ok) {
                  responseBytes += frame.value.value.byteLength;
                  output.enqueue(frame.value.value);
                } else {
                  const { cause } = frame.value.error;
                  complete(status, cause);
                  running.discard(body);
                  bodyReleased = true;
                  stopped = true;
                  output.error(cause);
                }
                return;
              }
              bodyReleased = true;
              controller.abort();
              await running.done;
              if (stopped) return;
              complete(status);
              output.close();
            } catch (error) {
              bodyReleased = true;
              onPanic(output, error);
            }
          })();
          return pending;
        },
        async cancel(reason) {
          stopped = true;
          complete(status, reason ?? new Error('Downstream cancelled the HTTP response'));
          await releaseBody();
        },
      });
      const clientResponse = new Response(bytes, { status, statusText, headers });
      discardBody = undefined;
      return clientResponse;
    } catch (error) {
      const panic = panicError(error);
      complete(500, panic);
      discardBody?.();
      return internalErrorResponse(panic, c);
    }
  };
