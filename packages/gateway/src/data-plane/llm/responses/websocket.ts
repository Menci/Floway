import type { Context } from 'hono';

import { RESPONSES_MISSING_TERMINAL_MESSAGE } from './events/to-result.ts';
import { createResponsesWsSession } from './items/store.ts';
import { PreviousResponseNotFoundError } from './serve-prep.ts';
import { responsesServe } from './serve.ts';
import { tokenUsage } from '../../shared/telemetry/usage.ts';
import { createGatewayCtxForWs, type GatewayCtx } from '../shared/gateway-ctx.ts';
import { SourceStreamState, eventResultMetadata, recordPerformance, recordUsage } from '../shared/respond.ts';
import type { StreamCompletion } from '../shared/stream/sse.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { isResponsesTerminalEvent, type ResponsesPayload, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult } from '@floway-dev/provider';
import { toInternalDebugError } from '@floway-dev/provider';

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

export const responsesWebSocket = async (c: Context): Promise<Response> => {
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

const createResponsesWebSocketEvents = (c: Context): ResponsesWebSocketHandlers => {
  const session = createResponsesWsSession(c.get('apiKeyId') as string);
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
  c: Context,
  socket: ResponsesWebSocketSocket,
  session: ReturnType<typeof createResponsesWsSession>,
  data: unknown,
  downstreamAbortController: AbortController,
  isClosed: () => boolean,
): Promise<void> => {
  const signal = downstreamAbortController.signal;
  let eventId: string | undefined;
  try {
    const parsed = parseClientMessageData(data);
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
    const ctx = createGatewayCtxForWs(c, downstreamAbortController);
    const store = session.createStore(payload.store ?? undefined);
    const snapshotMode = payload.store === false ? 'none' : 'append';

    let result;
    try {
      result = await responsesServe.generate({ payload, ctx, store, snapshotMode });
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
  }
};

class WebSocketClientMessageError extends Error {}

const parseClientMessageData = (data: unknown): unknown => {
  const text = typeof data === 'string'
    ? data
    : data instanceof ArrayBuffer
      ? new TextDecoder().decode(data)
      : ArrayBuffer.isView(data)
        ? new TextDecoder().decode(data)
        : null;
  if (text === null) throw new WebSocketClientMessageError(`Unsupported WebSocket message data: ${typeof data}`);

  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new WebSocketClientMessageError(`WebSocket message must be valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
};

const validateClientMessage = (parsed: unknown): ResponsesWebSocketClientEvent => {
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
    throw new WebSocketClientMessageError('WebSocket message must be a JSON object with a string type.');
  }
  return parsed as ResponsesWebSocketClientEvent;
};

const responsesPayloadFromClientSource = (source: object): ResponsesPayload => {
  const candidate = source as { model?: unknown; input?: unknown };
  if (typeof candidate.model !== 'string' || candidate.model.length === 0) {
    throw new WebSocketClientMessageError('response.create requires response.model to be a non-empty string.');
  }
  if (typeof candidate.input !== 'string' && !Array.isArray(candidate.input)) {
    throw new WebSocketClientMessageError('response.create requires response.input to be a string or an array.');
  }
  return { ...source, stream: true } as ResponsesPayload;
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
  if (result.type === 'upstream-error') {
    recordPerformance(ctx, result.performance, true);
    sendError(socket, result.status, normalizeErrorBody(parseMaybeJson(result.body, result.headers), result.status), eventId);
    return;
  }

  if (result.type === 'internal-error') {
    recordPerformance(ctx, result.performance, true);
    sendError(socket, result.status, internalErrorEnvelope(result.error), eventId);
    return;
  }

  const state = new SourceStreamState();
  let completion: StreamCompletion = 'error';
  try {
    let terminalEvent: ResponsesStreamEvent | undefined;
    for await (const frame of result.events) {
      if (signal.aborted || isClosed()) {
        completion = 'cancel';
        return;
      }
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
        completion = 'cancel';
        return;
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
    try {
      await recordUsage(ctx, metadata.modelIdentity, state.usage);
    } catch (error) {
      console.error('Failed to record Responses WebSocket usage:', error);
    } finally {
      recordPerformance(ctx, metadata.performance, state.failedAfter(completion));
    }
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
  source_api: error.source_api,
  target_api: error.target_api,
});

const serverErrorEnvelope = (error: unknown): Record<string, unknown> => ({
  ...toInternalDebugError(error, 'responses'),
  code: 'internal_error',
});

const tokenUsageFromResponsesResult = (response: ResponsesResult) => {
  const usage = response.usage;
  if (!usage) return null;
  const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;
  return tokenUsage({
    input: usage.input_tokens - cacheRead,
    input_cache_read: cacheRead,
    output: usage.output_tokens,
  });
};

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
