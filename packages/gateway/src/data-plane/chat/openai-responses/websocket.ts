import type { Context } from 'hono';

import { createNonOpenAIResponsesSourceStore, createOpenAIResponsesWsSession } from './items/store.ts';
import { OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE } from './response-headers.ts';
import { createOpenAIResponsesResponseId } from './response-id.ts';
import type { WebSocketIngress, WebSocketTurnInput } from './websocket-ingress.ts';
import { encodeWebSocketFrame, webSocketError, type WebSocketInterrupt, WebSocketSendError, webSocketServerError } from './websocket-wire.ts';
import { apiKeyFromContext, authenticateApiKey, type AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { gatewayHostContext, httpRequestFacts, startGatewayRun } from '../../pipeline/host.ts';
import { createGatewayServices } from '../../pipeline/services.ts';
import { Bytes, isManagedStream } from '@floway-dev/pipeline';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { isJsonObject } from '@floway-dev/protocols/common';
import { canonicalizeOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

export { INTERRUPT_UPSTREAM_ABORT_WARNING_MS } from './websocket-ingress.ts';
export { KEEP_ALIVE_EVENT_TYPE } from './websocket-wire.ts';

interface WorkerWebSocket extends WebSocket {
  accept(): void;
}

interface OpenAIResponsesWebSocketSocket {
  readonly readyState: number;
  send(data: string): void;
}

interface OpenAIResponsesWebSocketHandlers {
  onMessage(event: { readonly data: unknown }, socket: OpenAIResponsesWebSocketSocket): void;
  onClose(event: unknown, socket: OpenAIResponsesWebSocketSocket): void;
  onError(event: unknown, socket: OpenAIResponsesWebSocketSocket): void;
}

type OpenAIResponsesWebSocketUpgradeResolver = (
  c: Context, events: OpenAIResponsesWebSocketHandlers,
) => Response | Promise<Response>;

let upgradeResolver: OpenAIResponsesWebSocketUpgradeResolver | undefined;

export const initOpenAIResponsesWebSocketUpgradeResolver = (resolver: OpenAIResponsesWebSocketUpgradeResolver): void => {
  upgradeResolver = resolver;
};

declare const WebSocketPair: {
  new(): { 0: WorkerWebSocket; 1: WorkerWebSocket };
};

export const createOpenAIResponsesWebSocketHandler = (ingress: WebSocketIngress) => async (c: AuthedContext): Promise<Response> => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return Response.json({ error: 'Expected Upgrade: websocket' }, { status: 426 });
  }
  const events = createConnection(c, ingress);
  c.header(OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE);
  if (upgradeResolver !== undefined) return await upgradeResolver(c, events);

  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.addEventListener('close', event => events.onClose(event, server));
  server.addEventListener('error', event => events.onError(event, server));
  server.addEventListener('message', event => events.onMessage(event, server));
  return new Response(null, { status: 101, webSocket: client } as ResponseInit & { readonly webSocket: WebSocket });
};

const invalidRequest = (message: string, code = 'invalid_request_error') =>
  webSocketError(400, { type: 'invalid_request_error', code, message });

const invalidKey = () => webSocketError(401, {
  type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API key.',
});

const frameBytes = (data: unknown): Bytes | undefined => {
  if (typeof data === 'string') return Bytes.fromUtf8(data);
  if (data instanceof ArrayBuffer) return Bytes.copy(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return Bytes.copy(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return undefined;
};

interface ParsedMessage {
  readonly bytes: Bytes;
  readonly message: Record<string, unknown> & { readonly type: string };
  readonly eventId: string | undefined;
}

const parseMessage = (data: unknown): ParsedMessage | {
  readonly error: ReturnType<typeof webSocketError>; readonly eventId: string | undefined;
} => {
  const bytes = frameBytes(data);
  if (bytes === undefined) return { error: invalidRequest(`Unsupported WebSocket message data: ${typeof data}`), eventId: undefined };
  let value: unknown;
  try {
    value = JSON.parse(bytes.utf8());
  } catch (cause) {
    return {
      error: invalidRequest(`WebSocket message must be valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`),
      eventId: undefined,
    };
  }
  const eventId = isJsonObject(value) && typeof value.event_id === 'string' ? value.event_id : undefined;
  if (!isJsonObject(value) || typeof value.type !== 'string') {
    return { error: invalidRequest('WebSocket message must be a JSON object with a string type.'), eventId };
  }
  return { bytes, message: { ...value, type: value.type }, eventId };
};

const sendFrame = (socket: OpenAIResponsesWebSocketSocket, frame: Bytes) => {
  if (socket.readyState !== 1) throw new WebSocketSendError('Responses WebSocket is closed');
  try {
    socket.send(frame.utf8());
  } catch (cause) {
    throw new WebSocketSendError('Failed to send a Responses WebSocket frame', { cause });
  }
};

const sendError = (socket: OpenAIResponsesWebSocketSocket, frame: ReturnType<typeof webSocketError>, eventId: string | undefined) =>
  sendFrame(socket, encodeWebSocketFrame(frame, eventId));

const createControls = () => {
  let pending: ((control: WebSocketInterrupt | undefined) => void) | undefined;
  let queued: WebSocketInterrupt | undefined;
  return {
    push(control: WebSocketInterrupt): void {
      if (pending === undefined) queued = control;
      else pending(control);
    },
    async *iterate(signal: AbortSignal): AsyncGenerator<WebSocketInterrupt> {
      const onAbort = () => pending?.(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        while (!signal.aborted) {
          const control = queued ?? await new Promise<WebSocketInterrupt | undefined>(resolve => { pending = resolve; });
          pending = undefined;
          queued = undefined;
          if (control !== undefined && !signal.aborted) yield control;
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
};

interface ActiveTurn {
  readonly id: string;
  readonly abort: AbortController;
  readonly controls: ReturnType<typeof createControls>;
  interruptQueued: boolean;
}

const createConnection = (c: AuthedContext, ingress: WebSocketIngress): OpenAIResponsesWebSocketHandlers => {
  // Codex reuses a socket across turns, so resolve the presented credential
  // before each turn and control message to pick up revocation and policy edits.
  const rawKey = apiKeyFromContext(c).key;
  const session = createOpenAIResponsesWsSession();
  const connection = new AbortController();
  let active: ActiveTurn | undefined;
  let queue = Promise.resolve();
  const terminalResponses = new Set<string>();

  // Workers can register waitUntil while the upgrade's fetch is running.
  // Hold a single lifetime open until the socket closes and its turns, dump
  // pumps and settlement writes finish.
  const closed = Promise.withResolvers<void>();
  const pending = new Set<Promise<unknown>>();
  const scheduler: BackgroundScheduler = promise => {
    const tracked = promise.catch(error => console.error('[ws-background]', error)).finally(() => { pending.delete(tracked); });
    pending.add(tracked);
  };
  backgroundSchedulerFromContext(c)((async () => {
    await closed.promise;
    while (pending.size > 0) await Promise.allSettled([...pending]);
  })());
  const close = () => {
    connection.abort(new Error('Responses WebSocket closed'));
    closed.resolve();
  };

  // Codex targets the response id it saw on response.created.
  // https://github.com/openai/codex/blob/12de0e395d3313bc564190d983cb4f5acf0be713/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L688-L704
  const interrupt = async (socket: OpenAIResponsesWebSocketSocket, { message, eventId }: ParsedMessage, turn: ActiveTurn | undefined) => {
    if (!(await authenticateApiKey(c, rawKey))) {
      sendError(socket, invalidKey(), eventId);
      return;
    }
    if (connection.signal.aborted) return;
    const id = message.response_id;
    if (typeof id !== 'string' || id.length === 0 || message.mode !== 'discard_partial_items') {
      sendError(socket, invalidRequest("response.interrupt requires response_id and mode='discard_partial_items'."), eventId);
      return;
    }
    if (terminalResponses.has(id) || (turn?.id === id && turn.interruptQueued)) return;
    if (turn?.id !== id || active !== turn) {
      sendError(socket, invalidRequest('The response to interrupt is not active on this connection.', 'response_not_found'), eventId);
      return;
    }
    turn.interruptQueued = true;
    turn.controls.push({ type: 'response.interrupt', response_id: id, mode: message.mode, event_id: eventId });
  };

  const create = async (socket: OpenAIResponsesWebSocketSocket, parsed: ReturnType<typeof parseMessage>) => {
    if (connection.signal.aborted) return;
    const { eventId } = parsed;
    if (!(await authenticateApiKey(c, rawKey))) {
      sendError(socket, invalidKey(), undefined);
      return;
    }
    if (connection.signal.aborted) return;
    if ('error' in parsed) {
      sendError(socket, parsed.error, eventId);
      return;
    }
    const { message, bytes } = parsed;
    if (message.type !== 'response.create') {
      sendError(socket, invalidRequest(`Unsupported WebSocket event type '${message.type}'.`), eventId);
      return;
    }
    // The specification puts fields at the top level, and the Realtime-style
    // response envelope takes precedence when present.
    // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L99-L115
    const { type: _type, event_id: _eventId, ...fields } = message;
    const envelope = fields.response;
    const source = envelope !== null && typeof envelope === 'object' ? envelope : fields;
    const payload = canonicalizeOpenAIResponsesPayload({ ...source, stream: true });
    if (!('input' in payload)) {
      const { error } = payload;
      sendError(socket, webSocketError(400, { ...error, type: 'invalid_request_error', code: error.code ?? 'invalid_request_error' }), eventId);
      return;
    }

    const turn: ActiveTurn = {
      id: createOpenAIResponsesResponseId(), abort: new AbortController(), controls: createControls(),
      interruptQueued: false,
    };
    active = turn;
    const signal = AbortSignal.any([connection.signal, turn.abort.signal]);
    const startedAt = Date.now();
    const host = gatewayHostContext(c, scheduler);
    const request = httpRequestFacts(c.req.raw, bytes, 'WS');
    const services = createGatewayServices({
      apiKey: host.apiKey, runtimeLocation: host.route['request.route.runtimeLocation'], requestStartedAt: startedAt,
      responsesStore: mode => mode.kind === 'http'
        ? session.createStore(host.apiKey, startedAt, mode.store)
        : createNonOpenAIResponsesSourceStore(host.apiKey.id),
    });
    const previousResponseId = payload.previous_response_id;
    // A failed continuation evicts its connection-local history.
    // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L127
    const evict = () => {
      if (previousResponseId != null) session.evictSnapshot(host.apiKey.id, previousResponseId);
    };
    try {
      const handle = startGatewayRun(ingress, (root): WebSocketTurnInput => ({
        ...host.route,
        'request.http': request,
        'request.startedAt': startedAt,
        'request.model': payload.model,
        'request.openaiResponses': payload,
        'request.action': 'generate',
        'request.delivery': { stream: true, createdAt: Math.floor(startedAt / 1000) },
        'request.ws.responseId': turn.id,
        'request.ws.eventId': eventId,
        'request.ws.controls': root.createStream({ label: 'Responses WebSocket client controls', iterate: scope => turn.controls.iterate(scope.signal) }),
      }), {
        ...host, request, services, signal, requestedModel: payload.model, errorStatus: () => 500,
      });
      const result = await handle.result;
      const { body, status } = result['response.http'];
      if (!isManagedStream(body)) throw new TypeError('Responses WebSocket turn must produce a stream of frames');
      for await (const frame of body) {
        if (signal.aborted) break;
        try {
          if (!(frame instanceof Bytes)) throw new TypeError('Responses WebSocket encoder must emit bytes');
          sendFrame(socket, frame);
        } catch (error) {
          turn.abort.abort(error);
          throw error;
        }
      }
      const outcome = await result['response.render'].promise;
      if (status >= 400 || outcome.kind !== 'completed' || signal.aborted) evict();
      if (status < 400 && !signal.aborted && (outcome.kind === 'completed' || (outcome.kind === 'failed' && outcome.reason === 'protocol-error'))) {
        terminalResponses.add(turn.id);
      }
    } catch (error) {
      evict();
      if (error instanceof WebSocketSendError) turn.abort.abort(error);
      else if (!signal.aborted) sendError(socket, webSocketServerError(error), eventId);
    } finally {
      active = undefined;
    }
  };

  const reportFailure = (socket: OpenAIResponsesWebSocketSocket, error: unknown) => {
    if (error instanceof WebSocketSendError) active?.abort.abort(error);
    else if (!connection.signal.aborted) sendError(socket, webSocketServerError(error), undefined);
  };
  return {
    onClose: close,
    onError: close,
    onMessage: (event, socket) => {
      if (connection.signal.aborted) return;
      const parsed = parseMessage(event.data);
      if ('message' in parsed && parsed.message.type === 'response.interrupt') {
        scheduler(interrupt(socket, parsed, active).catch(error => reportFailure(socket, error)));
        return;
      }
      queue = queue.then(() => create(socket, parsed)).catch(error => reportFailure(socket, error));
      scheduler(queue);
    },
  };
};
