import type { Context } from 'hono';

import { createResponsesWsSession } from './items/store.ts';
import { PreviousResponseNotFoundError } from './serve-prep.ts';
import { responsesServe } from './serve.ts';
import { tokenUsageFromResponsesResult } from './usage.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { inboundHeadersForUpstream } from '../../shared/inbound-headers.ts';
import { createChatGatewayCtxFromHono, type ChatGatewayCtx, type GatewayCtx } from '../shared/gateway-ctx.ts';
import { SourceStreamState, eventResultMetadata, recordPerformance, recordUsage } from '../shared/respond.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS, type StreamCompletion } from '../shared/stream/sse.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { RESPONSES_MISSING_TERMINAL_MESSAGE } from '@floway-dev/protocols/responses';
import { isResponsesTerminalEvent, type ResponsesPayload, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult } from '@floway-dev/provider';
import { toInternalDebugError } from '@floway-dev/provider';
import { canonicalizeResponsesPayload, type CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

interface WorkerWebSocket extends WebSocket {
  accept(): void;
}

interface ResponsesWebSocketSocket {
  readonly readyState: number;
  send(data: string): void;
}

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
  response?: Partial<ResponsesPayload>;
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
  const session = createResponsesWsSession();
  let closed = false;
  let activeAbortController: AbortController | undefined;
  let queue = Promise.resolve();

  const closeActiveRequest = (): void => {
    closed = true;
    activeAbortController?.abort();
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
            await handleClientMessage(c, socket, session, event.data, abortController, () => closed);
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
  downstreamAbortController: AbortController,
  isClosed: () => boolean,
): Promise<void> => {
  const signal = downstreamAbortController.signal;
  let eventId: string | undefined;
  let ctx: ChatGatewayCtx | undefined;
  try {
    // Capture raw frame bytes up front so they're available as the dump's
    // request body when `ctx` is constructed below. Payloads that fail to
    // parse never reach ctx construction, so no dump record is emitted for
    // them — there is no api-key-scoped turn to attribute them to.
    const requestBytes = wsDataToBytes(data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(requestBytes)) as unknown;
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
      requestBody: { bytes: requestBytes, streamError: null },
      method: 'WS',
      model: payload.model,
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
        }, eventId);
        ctx.dump?.failed(error);
        ctx.dump?.finalize(400, []);
        return;
      }
      throw error;
    }

    await respondResponsesWebSocket({ socket, eventId, signal, isClosed, result, ctx });
  } catch (error) {
    if (signal.aborted || isClosed()) return;
    if (error instanceof WebSocketClientMessageError) {
      sendError(socket, 400, {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: error.message,
      }, eventId);
      return;
    }
    sendError(socket, 500, serverErrorEnvelope(error), eventId);
    if (ctx !== undefined) {
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
  // Feed the wire shape through the same canonicalization the HTTP entry uses,
  // then stamp `stream: true` — the WS transport streams every turn.
  return { ...canonicalizeResponsesPayload(source as ResponsesPayload), stream: true };
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
    recordPerformance(ctx, result.performance, true);
    ctx.dump?.error(result.source, result.upstream);
    ctx.dump?.finalize(result.status, []);
    sendError(socket, result.status, normalizeErrorBody(parseMaybeJson(result.body, result.headers), result.status), eventId);
    return;
  }

  if (result.type === 'internal-error') {
    recordPerformance(ctx, result.performance, true);
    ctx.dump?.failed(result.error.message);
    ctx.dump?.finalize(result.status, []);
    sendError(socket, result.status, internalErrorEnvelope(result.error), eventId);
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
          if (!sendJson(socket, { type: 'ping' }, eventId)) {
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

        // The upstream terminal event flushes immediately; we then drain the
        // remainder of the generator (storage commit, any post-terminal frames)
        // before emitting the WS-only `response.done` envelope, so the client
        // sees `response.done` last and treats it as the stable signal that the
        // stored response can be referenced by a follow-up message.
        if (terminalEvent !== undefined) continue;

        if (isResponsesTerminalEvent(event)) {
          if (!sendJson(socket, event, eventId)) {
            completion = 'cancel';
            continue;
          }
          if (!failed) state.completed = true;
          terminalEvent = event;
          continue;
        }

        if (!sendJson(socket, event, eventId)) {
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
    if (done !== null && !sendJson(socket, { type: 'response.done', response: done }, eventId)) {
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
    sendError(socket, 500, serverErrorEnvelope(error), eventId);
  } finally {
    const metadata = await eventResultMetadata(result);
    const failed = state.failedAfter(completion);
    if (failed) ctx.dump?.failed(`responses ws turn failed (completion=${completion}, source-failed=${state.failed})`);
    else ctx.dump?.success(metadata.modelIdentity, state.usage);
    ctx.dump?.finalize(failed ? 500 : 200, []);
    try {
      await recordUsage(ctx, metadata.modelIdentity, state.usage);
    } catch (error) {
      console.error('Failed to record Responses WebSocket usage:', error);
    } finally {
      recordPerformance(ctx, metadata.performance, failed);
    }
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

const responseDoneSummary = (event: unknown) => {
  if (!event || typeof event !== 'object') return null;
  const type = (event as { type?: unknown }).type;
  if (type !== 'response.completed' && type !== 'response.failed' && type !== 'response.incomplete') return null;
  const response = (event as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return null;
  const id = (response as { id?: unknown }).id;
  if (typeof id !== 'string') return null;
  const usage = (response as { usage?: ResponsesResult['usage'] }).usage;
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

const sendError = (socket: ResponsesWebSocketSocket, statusCode: number, error: Record<string, unknown>, eventId?: string): void => {
  sendJson(socket, { type: 'error', status_code: statusCode, error }, eventId);
};

const sendJson = (socket: ResponsesWebSocketSocket, value: unknown, eventId?: string): boolean => {
  if (socket.readyState !== 1) return false;
  const payload = eventId === undefined || !value || typeof value !== 'object'
    ? value
    : { ...value, event_id: eventId };
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
};
