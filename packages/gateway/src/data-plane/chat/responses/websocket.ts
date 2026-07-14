import type { Context } from 'hono';

import { createResponsesWsSession } from './items/store.ts';
import { PreviousResponseNotFoundError } from './serve-prep.ts';
import { responsesServe } from './serve.ts';
import { tokenUsageFromResponsesResult } from './usage.ts';
import type { DumpAccumulator } from '../../../dump/accumulator.ts';
import { apiKeyFromContext, authenticateApiKey, type AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { inboundHeadersForUpstream } from '../../shared/inbound-headers.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { createChatGatewayCtxFromHono, type ChatGatewayCtx, type GatewayCtx } from '../shared/gateway-ctx.ts';
import { takeRequestBody } from '../shared/request-body.ts';
import { SourceStreamState, eventResultMetadata } from '../shared/respond.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS, type StreamCompletion } from '../shared/stream/sse.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { RESPONSES_MISSING_TERMINAL_MESSAGE } from '@floway-dev/protocols/responses';
import { isResponsesTerminalEvent, type CanonicalResponsesPayload, type ResponsesRequestPayload, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult } from '@floway-dev/provider';
import { toInternalDebugError } from '@floway-dev/provider';
import { TranslatorInputError } from '@floway-dev/translate';
import { canonicalizeResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

interface WorkerWebSocket extends WebSocket {
  accept(): void;
}

interface ResponsesWebSocketSocket {
  readonly readyState: number;
  send(data: string): void;
}

const UTF8_ENCODER = new TextEncoder();

export interface ResponsesWebSocketEvents {
  onOpen?(event: Event, socket: ResponsesWebSocketSocket): void;
  onMessage?(event: { readonly data: unknown }, socket: ResponsesWebSocketSocket): void;
  onClose?(event: unknown, socket: ResponsesWebSocketSocket): void;
  onError?(event: unknown, socket: ResponsesWebSocketSocket): void;
}

interface ResponsesWebSocketHandlers {
  onMessage(event: { readonly data: unknown }, socket: ResponsesWebSocketSocket): void;
  onClose(event: unknown, socket: ResponsesWebSocketSocket): void;
  onError(event: unknown, socket: ResponsesWebSocketSocket): void;
}

type ResponsesWebSocketUpgradeResolver = (
  c: Context,
  events: ResponsesWebSocketHandlers,
) => Response | Promise<Response>;

let _responsesWebSocketUpgradeResolver: ResponsesWebSocketUpgradeResolver | null = null;

export const initResponsesWebSocketUpgradeResolver = (
  resolver: ResponsesWebSocketUpgradeResolver,
): void => {
  _responsesWebSocketUpgradeResolver = resolver;
};

declare const WebSocketPair: {
  new(): {
    0: WorkerWebSocket;
    1: WorkerWebSocket;
  };
};

interface ResponsesWebSocketClientEvent {
  type: string;
  event_id?: string;
  response?: Partial<ResponsesRequestPayload>;
  [key: string]: unknown;
}

export const responsesWebSocket = async (c: AuthedContext): Promise<Response> => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return Response.json({ error: 'Expected Upgrade: websocket' }, { status: 426 });
  }

  const events = createResponsesWebSocketEvents(c);
  if (_responsesWebSocketUpgradeResolver !== null) {
    return await _responsesWebSocketUpgradeResolver(c, events);
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  server.addEventListener('close', event => events.onClose(event, server));
  server.addEventListener('error', event => events.onError(event, server));
  server.addEventListener('message', event => events.onMessage(event, server));

  return new Response(null, { status: 101, webSocket: client } as ResponseInit & { readonly webSocket: WebSocket });
};

const createResponsesWebSocketEvents = (c: AuthedContext): ResponsesWebSocketHandlers => {
  // The upgrade authenticates the connection, but every response.create is a
  // separate data-plane request. Codex deliberately reuses one socket across
  // turns, so retain the presented credential and resolve it again before each
  // turn rather than freezing key/user policy at upgrade time.
  const authenticatedRawKey = apiKeyFromContext(c).key;
  const session = createResponsesWsSession();
  let closed = false;
  let activeAbortController: AbortController | undefined;
  let queue = Promise.resolve();

  // ── Session-scoped BackgroundScheduler ──────────────────────────────────
  //
  // The runtime's default scheduler on Cloudflare is
  // `promise => c.executionCtx.waitUntil(promise)`. That call is only legal
  // during the fetch invocation; once the fetch handler returns the 101
  // upgrade, subsequent waitUntil calls made from message-event handlers
  // are silently dropped (the promise never runs, the isolate has no
  // registered reason to defer eviction for it). Every per-message background
  // task — dump.finalize, settle, recordFailedRequest — would therefore
  // lose its write.
  //
  // Fix: give the ctx a scheduler that doesn't depend on the fetch's
  // execution context at all. `sessionScheduler` tracks the task in
  // `pendingWork`; the isolate stays alive throughout because we register
  // ONE lifetime promise up-front (while the fetch handler is still
  // running, so this waitUntil IS legal) that only resolves when
  // (WS closed ∧ pendingWork drained).
  //
  // The drain uses a `while (size > 0)` loop rather than a single
  // `Promise.allSettled(pendingWork)` snapshot: the in-flight message
  // handler running at close time may still enqueue a final
  // dump.finalize / settle / recordFailedRequest from its finally/catch after
  // `sessionClosed` resolves. The loop keeps going until the Set is
  // genuinely empty, which is bounded because `closed = true` short-
  // circuits future message handlers at the top of `handleClientMessage`.
  const pendingWork = new Set<Promise<unknown>>();
  let sessionClosedResolve: (() => void) | undefined;
  const sessionClosed = new Promise<void>(resolve => { sessionClosedResolve = resolve; });
  const sessionScheduler: BackgroundScheduler = promise => {
    const tracked: Promise<unknown> = Promise.resolve(promise)
      .catch(err => console.error('[ws-background]', err))
      .finally(() => { pendingWork.delete(tracked); });
    pendingWork.add(tracked);
  };
  backgroundSchedulerFromContext(c)((async () => {
    await sessionClosed;
    while (pendingWork.size > 0) {
      await Promise.allSettled([...pendingWork]);
    }
  })());

  const closeActiveRequest = (): void => {
    closed = true;
    activeAbortController?.abort();
    sessionClosedResolve?.();
  };

  return {
    onClose: closeActiveRequest,
    onError: closeActiveRequest,
    onMessage: (event, socket) => {
      queue = queue
        .then(async () => {
          if (closed) return;
          const abortController = new AbortController();
          activeAbortController = abortController;
          try {
            await handleClientMessage(c, socket, session, event.data, authenticatedRawKey, abortController, () => closed, sessionScheduler);
          } finally {
            if (activeAbortController === abortController) activeAbortController = undefined;
          }
        })
        // WS-specific top-level: Hono's onError never runs for callbacks fired off
        // an open socket, so we serialize the error inline as a close-frame-shaped
        // JSON envelope. (HTTP entries let onError handle the same case.)
        .catch(error => {
          if (!closed) sendError(socket, 500, serverErrorEnvelope(error));
        });
    },
  };
};

const handleClientMessage = async (
  c: AuthedContext,
  socket: ResponsesWebSocketSocket,
  session: ReturnType<typeof createResponsesWsSession>,
  data: unknown,
  authenticatedRawKey: string,
  downstreamAbortController: AbortController,
  isClosed: () => boolean,
  backgroundScheduler: BackgroundScheduler,
): Promise<void> => {
  const signal = downstreamAbortController.signal;
  let eventId: string | undefined;
  let ctx: ChatGatewayCtx | undefined;
  try {
    // Capture raw frame bytes up front so they're available as the dump's
    // request body when `ctx` is constructed below. Payloads that fail to
    // parse never reach ctx construction, so no dump record is emitted for
    // them — there is no api-key-scoped turn to attribute them to.
    const requestBody = { bytes: wsDataToBytes(data), streamError: null };
    if (!(await authenticateApiKey(c, authenticatedRawKey))) {
      sendError(socket, 401, {
        type: 'authentication_error',
        code: 'invalid_api_key',
        message: 'Invalid API key.',
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(requestBody.bytes)) as unknown;
    } catch (cause) {
      throw new WebSocketClientMessageError(`WebSocket message must be valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    eventId = parsed && typeof parsed === 'object' && typeof (parsed as { event_id?: unknown }).event_id === 'string'
      ? (parsed as { event_id: string }).event_id
      : undefined;
    const message = validateClientMessage(parsed);
    if (message.type !== 'response.create') {
      sendError(socket, 400, {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: `Unsupported WebSocket event type '${message.type}'.`,
      }, eventId);
      return;
    }

    const source = message.response && typeof message.response === 'object'
      ? message.response
      : Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'type' && key !== 'event_id'));
    const payload = responsesPayloadFromClientSource(source);
    ctx = createChatGatewayCtxFromHono(c, {
      wantsStream: true,
      downstreamAbortController,
      // The WS upgrade has no HTTP body; the dump's request body is the
      // per-turn JSON frame bytes so an operator reading the dashboard
      // sees the exact `response.create` payload the client sent.
      requestBody: takeRequestBody(requestBody),
      method: 'WS',
      model: payload.model,
      backgroundScheduler,
    }, apiKeyId => session.createStore(apiKeyId, payload.store ?? undefined));

    let result;
    try {
      result = await responsesServe.generate({ payload, ctx, headers: inboundHeadersForUpstream(c) });
    } catch (error) {
      if (signal.aborted || isClosed()) return;
      // The HTTP entry renders this verbatim envelope as a 400; WS surfaces the
      // same body wrapped in our standard close-frame error shape so clients
      // can still compare error.message byte-for-byte against upstream.
      if (error instanceof PreviousResponseNotFoundError) {
        sendError(socket, 400, {
          message: error.message,
          type: 'invalid_request_error',
          param: 'previous_response_id',
          code: 'previous_response_not_found',
        }, eventId, ctx.dump);
        ctx.dump?.failed(error);
        ctx.dump?.finalize(400, []);
        return;
      }
      throw error;
    }

    await respondResponsesWebSocket({ socket, eventId, signal, isClosed, result, ctx });
  } catch (error) {
    if (signal.aborted || isClosed()) return;
    if (error instanceof TranslatorInputError) {
      sendError(socket, 400, {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: error.message,
        param: error.param,
      }, eventId);
      return;
    }
    if (error instanceof WebSocketClientMessageError) {
      sendError(socket, 400, {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: error.message,
      }, eventId);
      return;
    }
    sendError(socket, 500, serverErrorEnvelope(error), eventId, ctx?.dump);
    if (ctx !== undefined) {
      // Mid-attempt throws (interceptor bug, translation error, provider-layer JS
      // exception that bypassed tryCatchChatServeFailure) never reach the
      // respondResponsesWebSocket result branches, so their `recordFailedRequest`
      // call would be skipped. Attribute the failure to the last upstream stamped
      // synchronously by `responsesServe.generate`, matching the HTTP transports.
      recordFailedRequest(ctx, ctx.attempt.telemetry);
      ctx.dump?.failed(error);
      ctx.dump?.finalize(500, []);
    }
  }
};

class WebSocketClientMessageError extends Error {}

const wsDataToBytes = (data: unknown): Uint8Array => {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new WebSocketClientMessageError(`Unsupported WebSocket message data: ${typeof data}`);
};

const validateClientMessage = (parsed: unknown): ResponsesWebSocketClientEvent => {
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
    throw new WebSocketClientMessageError('WebSocket message must be a JSON object with a string type.');
  }
  return parsed as ResponsesWebSocketClientEvent;
};

const responsesPayloadFromClientSource = (source: object): CanonicalResponsesPayload => {
  const candidate = source as { model?: unknown; input?: unknown };
  if (typeof candidate.model !== 'string' || candidate.model.length === 0) {
    throw new WebSocketClientMessageError('response.create requires response.model to be a non-empty string.');
  }
  if (typeof candidate.input !== 'string' && !Array.isArray(candidate.input)) {
    throw new WebSocketClientMessageError('response.create requires response.input to be a string or an array.');
  }
  // stamp stream: true — the WS transport always streams.
  return { ...canonicalizeResponsesPayload(source as ResponsesRequestPayload), stream: true };
};

const respondResponsesWebSocket = async (input: {
  readonly socket: ResponsesWebSocketSocket;
  readonly eventId: string | undefined;
  readonly signal: AbortSignal;
  readonly isClosed: () => boolean;
  readonly result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>;
  readonly ctx: GatewayCtx;
}): Promise<void> => {
  const { socket, eventId, signal, isClosed, result, ctx } = input;
  if (result.type === 'api-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.error(result.source, result.upstream);
    sendError(socket, result.status, normalizeErrorBody(parseMaybeJson(result.body, result.headers), result.status), eventId, ctx.dump);
    ctx.dump?.finalize(result.status, []);
    return;
  }

  if (result.type === 'internal-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.failed(result.error.message);
    sendError(socket, result.status, internalErrorEnvelope(result.error), eventId, ctx.dump);
    ctx.dump?.finalize(result.status, []);
    return;
  }

  const state = new SourceStreamState();
  let completion: StreamCompletion = 'error';
  try {
    let terminalEvent: ResponsesStreamEvent | undefined;
    const iterator = result.events[Symbol.asyncIterator]();
    let pendingNext = pendingWsFrameResult(iterator.next());
    let completed = false;
    let stoppedByDownstream = false;

    const stopForDownstream = (): void => {
      stoppedByDownstream = true;
      completion = 'cancel';
    };

    try {
      while (true) {
        if (signal.aborted || isClosed()) {
          stopForDownstream();
          return;
        }

        const next = await nextFrameOrKeepAlive(pendingNext);

        if (next.type === 'keep-alive') {
          if (!sendJson(socket, { type: 'ping' }, eventId, ctx.dump)) {
            stopForDownstream();
            return;
          }
          continue;
        }
        if (next.type === 'next-error') throw next.error;
        if (next.result.done) {
          completed = true;
          break;
        }

        const frame = next.result.value;
        pendingNext = pendingWsFrameResult(iterator.next());
        // Capture every frame (events + the `done` sentinel) so the
        // dashboard can reassemble the turn identically to the HTTP path.
        ctx.dump?.frame(frame);
        if (frame.type !== 'event') continue;

        const event = frame.event;
        const failed = event.type === 'error' || event.type === 'response.failed';
        if (failed) state.failed = true;
        state.rememberUsage('response' in event ? tokenUsageFromResponsesResult((event as { response: ResponsesResult }).response) : null);

        // The wrapped terminal event arrives only after its item and snapshot
        // writes have committed. Flush it immediately, then drain the remainder
        // of the generator before emitting the WS-only `response.done` envelope,
        // so `response.done` remains the stable signal that a follow-up message
        // can reference the stored response.
        if (terminalEvent !== undefined) continue;

        if (isResponsesTerminalEvent(event)) {
          if (!sendJson(socket, event, eventId, ctx.dump)) {
            completion = 'cancel';
            continue;
          }
          if (!failed) state.completed = true;
          terminalEvent = event;
          continue;
        }

        if (!sendJson(socket, event, eventId, ctx.dump)) {
          stopForDownstream();
          return;
        }
      }
    } finally {
      if (!completed) {
        const stopped = iterator.return?.();
        if (stoppedByDownstream) stopped?.catch(() => {});
        else await stopped;
      }
    }

    if (terminalEvent === undefined) {
      throw new Error(RESPONSES_MISSING_TERMINAL_MESSAGE);
    }
    const done = responseDoneSummary(terminalEvent);
    if (done !== null && !sendJson(socket, { type: 'response.done', response: done }, eventId, ctx.dump)) {
      completion = 'cancel';
      return;
    }
    if (completion !== 'cancel') completion = 'eof';
  } catch (error) {
    if (signal.aborted || isClosed()) {
      completion = 'cancel';
      return;
    }
    state.failed = true;
    sendError(socket, 500, serverErrorEnvelope(error), eventId, ctx.dump);
  } finally {
    const metadata = await eventResultMetadata(result);
    const failed = state.failedAfter(completion);
    if (failed) ctx.dump?.failed(`responses ws turn failed (completion=${completion}, source-failed=${state.failed})`);
    else ctx.dump?.success(metadata.modelIdentity, state.usage);
    ctx.dump?.finalize(failed ? 500 : 200, []);
    settle(ctx, metadata.performance, metadata.modelIdentity, state.usage, failed);
  }
};

type WsFrameRaceResult =
  | { type: 'frame'; result: IteratorResult<ProtocolFrame<ResponsesStreamEvent>> }
  | { type: 'next-error'; error: unknown }
  | { type: 'keep-alive' };

const pendingWsFrameResult = (pendingNext: Promise<IteratorResult<ProtocolFrame<ResponsesStreamEvent>>>): Promise<WsFrameRaceResult> =>
  pendingNext.then(
    (result): WsFrameRaceResult => ({ type: 'frame', result }),
    (error): WsFrameRaceResult => ({ type: 'next-error', error }),
  );

const nextFrameOrKeepAlive = async (pendingFrame: Promise<WsFrameRaceResult>): Promise<WsFrameRaceResult> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const keepAlive = new Promise<WsFrameRaceResult>(resolve => {
    timeoutId = setTimeout(() => resolve({ type: 'keep-alive' }), DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS);
  });
  try {
    return await Promise.race([pendingFrame, keepAlive]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

const parseMaybeJson = (body: Uint8Array, headers: Headers): unknown => {
  const text = new TextDecoder().decode(body);
  if (!(headers.get('content-type') ?? '').includes('application/json')) return { message: text };
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
};

const internalErrorEnvelope = (error: Extract<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>, { type: 'internal-error' }>['error']): Record<string, unknown> => ({
  type: error.type,
  code: error.type,
  name: error.name,
  message: error.message,
  stack: error.stack,
  cause: error.cause,
  target_api: error.target_api,
});

const serverErrorEnvelope = (error: unknown): Record<string, unknown> => ({
  ...toInternalDebugError(error),
  code: 'internal_error',
});

const responseDoneSummary = (event: ResponsesStreamEvent) => {
  if (event.type !== 'response.completed' && event.type !== 'response.failed' && event.type !== 'response.incomplete') return null;
  const { id, usage } = event.response;
  return usage === undefined ? { id } : { id, usage };
};

const normalizeErrorBody = (body: unknown, statusCode: number): Record<string, unknown> => {
  const source = body && typeof body === 'object' && 'error' in body && typeof (body as { error?: unknown }).error === 'object'
    ? (body as { error: Record<string, unknown> }).error
    : body && typeof body === 'object'
      ? body as Record<string, unknown>
      : {};
  const type = typeof source.type === 'string'
    ? source.type
    : statusCode >= 500 ? 'server_error' : 'invalid_request_error';
  const message = typeof source.message === 'string'
    ? source.message
    : `Responses request failed with status ${statusCode}.`;
  return {
    ...source,
    type,
    code: typeof source.code === 'string' ? source.code : type,
    message,
  };
};

const sendError = (
  socket: ResponsesWebSocketSocket,
  statusCode: number,
  error: Record<string, unknown>,
  eventId?: string,
  dump?: DumpAccumulator | null,
): void => {
  sendJson(socket, { type: 'error', status_code: statusCode, error }, eventId, dump);
};

const sendJson = (
  socket: ResponsesWebSocketSocket,
  value: unknown,
  eventId?: string,
  dump?: DumpAccumulator | null,
): boolean => {
  if (socket.readyState !== 1) return false;
  const payload = eventId === undefined || !value || typeof value !== 'object'
    ? value
    : { ...value, event_id: eventId };
  let text: string;
  try {
    text = JSON.stringify(payload);
    socket.send(text);
  } catch {
    return false;
  }
  dump?.recordSentPayloadBytes(UTF8_ENCODER.encode(text).byteLength);
  return true;
};
