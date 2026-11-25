import type { Context } from 'hono';

import { createOpenAIResponsesWsSession } from './items/store.ts';
import { openAIResponsesClientPipeline } from './pipeline/index.ts';
import { openAIResponsesRequestFacts } from './pipeline/parse-request.ts';
import { openAIResponsesServices } from './pipeline/services.ts';
import { OpenAIResponsesInterrupted } from './pipeline/websocket-interrupt.ts';
import { OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE } from './response-headers.ts';
import { createOpenAIResponsesResponseId } from './response-id.ts';
import { apiKeyFromContext, authenticateApiKey, type AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { getRuntimeLocation } from '../../../runtime/runtime-info.ts';
import { initialHttpFacts, startPipeline } from '../../pipeline/host.ts';
import { isHttpStreamError } from '../../pipeline/protocol-outcome.ts';
import { openPipelineRecorder } from '../../pipeline/recorder.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS } from '../../shared/sse.ts';
import { getHeader } from '@floway-dev/http';
import { move, type ManagedStream, type Result } from '@floway-dev/pipeline';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { isJsonObject } from '@floway-dev/protocols/common';
import { canonicalizeOpenAIResponsesPayload, isOpenAIResponsesTerminalEvent, OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE, type OpenAIResponsesRequestPayloadEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { internalDebugErrorFields, toInternalDebugError, type ProtocolStreamError } from '@floway-dev/provider';

interface WorkerWebSocket extends WebSocket {
  accept(): void;
}

interface OpenAIResponsesWebSocketSocket {
  readonly readyState: number;
  send(data: string): void;
}

// Our implementor slug prefixes the keep-alive's wire type; the spec reserves
// every unprefixed type for itself, gives `acme:trace_event` as the form, and
// makes `type` and `sequence_number` the only mandatory fields — which is all
// this frame carries.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L758-L765
// A slug type is inert in openai-node's WebSocket reader: the frame is emitted
// under its own literal type name, nothing is listening on that name, and only
// a frame typed `error` is routed into the socket's error path.
// https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/resources/responses/ws-base.ts#L346-L371
export const KEEP_ALIVE_EVENT_TYPE = 'floway:keep_alive';
export const INTERRUPT_UPSTREAM_ABORT_WARNING_MS = 5_000;

interface OpenAIResponsesWebSocketHandlers {
  onMessage(event: { readonly data: unknown }, socket: OpenAIResponsesWebSocketSocket): void;
  onClose(event: unknown, socket: OpenAIResponsesWebSocketSocket): void;
  onError(event: unknown, socket: OpenAIResponsesWebSocketSocket): void;
}

type OpenAIResponsesWebSocketUpgradeResolver = (
  c: Context,
  events: OpenAIResponsesWebSocketHandlers,
) => Response | Promise<Response>;

let _openai_responsesWebSocketUpgradeResolver: OpenAIResponsesWebSocketUpgradeResolver | null = null;

export const initOpenAIResponsesWebSocketUpgradeResolver = (
  resolver: OpenAIResponsesWebSocketUpgradeResolver,
): void => {
  _openai_responsesWebSocketUpgradeResolver = resolver;
};

declare const WebSocketPair: {
  new(): {
    0: WorkerWebSocket;
    1: WorkerWebSocket;
  };
};

// The spec puts the creation body's fields at the top level of
// `response.create`; the nested `response` envelope of Realtime-style clients
// is an extension we also accept, and prefer when present.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L99-L115
type OpenAIResponsesWebSocketClientEvent = Partial<OpenAIResponsesRequestPayloadEx> & {
  type: string;
  event_id?: string;
  response_id?: string;
  mode?: string;
  response?: Partial<OpenAIResponsesRequestPayloadEx>;
  [key: string]: unknown;
};

interface ActiveOpenAIResponsesWebSocketTurn {
  readonly responseId: string;
  readonly abortController: AbortController;
  created: boolean;
  interrupted: boolean;
  terminal: boolean;
  interruptWaitWarning?: ReturnType<typeof setTimeout> | undefined;
  requestInterrupt?: ((eventId: string | undefined) => void) | undefined;
}

export const openaiResponsesWebSocket = async (c: AuthedContext): Promise<Response> => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return Response.json({ error: 'Expected Upgrade: websocket' }, { status: 426 });
  }

  const events = createOpenAIResponsesWebSocketEvents(c);
  c.header(OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE);
  if (_openai_responsesWebSocketUpgradeResolver !== null) {
    return await _openai_responsesWebSocketUpgradeResolver(c, events);
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

const createOpenAIResponsesWebSocketEvents = (c: AuthedContext): OpenAIResponsesWebSocketHandlers => {
  // The upgrade authenticates the connection, but every response.create is a
  // separate data-plane request. Codex deliberately reuses one socket across
  // turns, so retain the presented credential and resolve it again before each
  // turn rather than freezing key/user policy at upgrade time.
  const authenticatedRawKey = apiKeyFromContext(c).key;
  const session = createOpenAIResponsesWsSession();
  let closed = false;
  let activeAbortController: AbortController | undefined;
  let activeTurn: ActiveOpenAIResponsesWebSocketTurn | undefined;
  const terminalResponseIds = new Set<string>();
  let queue = Promise.resolve();

  // Register the lifetime while the upgrade's execution context is active.
  // A turn and its pipeline settlement both hold the upgraded session open.
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
      const control = parseControlMessage(event.data);
      if (control?.type === 'response.interrupt') {
        const handled = handleInterruptMessage(control, socket, activeTurn, terminalResponseIds, c, authenticatedRawKey);
        sessionScheduler(handled);
        return;
      }
      queue = queue
        .then(async () => {
          if (closed) return;
          const abortController = new AbortController();
          const turn: ActiveOpenAIResponsesWebSocketTurn = {
            responseId: createOpenAIResponsesResponseId(),
            abortController,
            created: false,
            interrupted: false,
            terminal: false,
          };
          activeAbortController = abortController;
          activeTurn = turn;
          try {
            await handleClientMessage(c, socket, session, event.data, authenticatedRawKey, turn, () => closed, sessionScheduler);
          } finally {
            if (activeAbortController === abortController) activeAbortController = undefined;
            if (activeTurn === turn) activeTurn = undefined;
            if (turn.terminal) terminalResponseIds.add(turn.responseId);
          }
        })
        // WS-specific top-level: Hono's onError never runs for callbacks fired off
        // an open socket, so we serialize the error inline as the spec's
        // WebSocket error envelope. (HTTP entries let onError handle the same case.)
        .catch(error => {
          if (closed) throw error;
          sendError(socket, 500, serverErrorEnvelope(error));
        });
      sessionScheduler(queue);
    },
  };
};

const parseControlMessage = (data: unknown): OpenAIResponsesWebSocketClientEvent | undefined => {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(wsDataToBytes(data))) as unknown;
    if (!parsed || typeof parsed !== 'object' || (parsed as { type?: unknown }).type !== 'response.interrupt') return undefined;
    return parsed as OpenAIResponsesWebSocketClientEvent;
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof WebSocketClientMessageError)) throw error;
    return undefined;
  }
};

// Codex sends this control frame only after `response.created`, targeting the
// observed response ID and requesting `discard_partial_items`.
// https://github.com/openai/codex/blob/12de0e395d3313bc564190d983cb4f5acf0be713/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L688-L704
const handleInterruptMessage = async (
  message: OpenAIResponsesWebSocketClientEvent,
  socket: OpenAIResponsesWebSocketSocket,
  activeTurn: ActiveOpenAIResponsesWebSocketTurn | undefined,
  terminalResponseIds: ReadonlySet<string>,
  c: AuthedContext,
  authenticatedRawKey: string,
): Promise<void> => {
  const eventId = typeof message.event_id === 'string' ? message.event_id : undefined;
  if (!(await authenticateApiKey(c, authenticatedRawKey))) {
    sendError(socket, 401, {
      type: 'authentication_error',
      code: 'invalid_api_key',
      message: 'Invalid API key.',
    }, eventId);
    return;
  }
  if (typeof message.response_id !== 'string' || message.response_id.length === 0 || message.mode !== 'discard_partial_items') {
    sendError(socket, 400, {
      type: 'invalid_request_error',
      code: 'invalid_request_error',
      message: "response.interrupt requires response_id and mode='discard_partial_items'.",
    }, eventId);
    return;
  }
  if (terminalResponseIds.has(message.response_id)) return;
  if (activeTurn?.responseId === message.response_id && (activeTurn.interrupted || activeTurn.terminal)) return;
  if (activeTurn === undefined || activeTurn.responseId !== message.response_id || !activeTurn.created || activeTurn.requestInterrupt === undefined) {
    sendError(socket, 400, {
      type: 'invalid_request_error',
      code: 'response_not_found',
      message: 'The response to interrupt is not active on this connection.',
    }, eventId);
    return;
  }
  activeTurn.requestInterrupt(eventId);
};

const handleClientMessage = async (
  c: AuthedContext,
  socket: OpenAIResponsesWebSocketSocket,
  session: ReturnType<typeof createOpenAIResponsesWsSession>,
  data: unknown,
  authenticatedRawKey: string,
  turn: ActiveOpenAIResponsesWebSocketTurn,
  isClosed: () => boolean,
  backgroundScheduler: BackgroundScheduler,
): Promise<void> => {
  const { signal } = turn.abortController;
  let eventId: string | undefined;
  let keyId: string | undefined;
  let previousResponseId: string | undefined;
  // A failed continuation evicts the referenced connection-local snapshot.
  // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L127
  const evict = (): void => {
    if (keyId !== undefined && previousResponseId !== undefined) session.evictSnapshot(keyId, previousResponseId);
  };
  const fail = (status: number, error: Record<string, unknown>, retryAfter?: string): void => {
    evict();
    sendError(socket, status, error, eventId, retryAfter);
  };

  try {
    const bytes = wsDataToBytes(data);
    if (!(await authenticateApiKey(c, authenticatedRawKey))) {
      fail(401, { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API key.' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
      throw new WebSocketClientMessageError(`WebSocket message must be valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    eventId = isJsonObject(parsed) && typeof parsed.event_id === 'string' ? parsed.event_id : undefined;
    const message = validateClientMessage(parsed);
    if (message.type !== 'response.create') {
      fail(400, {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: `Unsupported WebSocket event type '${message.type}'.`,
      });
      return;
    }

    const source = message.response && typeof message.response === 'object'
      ? message.response
      : Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'type' && key !== 'event_id'));
    const payload = canonicalizeOpenAIResponsesPayload({ ...source, stream: true });
    if ('error' in payload) {
      fail(400, { type: 'invalid_request_error', code: payload.error.code ?? 'invalid_request_error', message: payload.error.message, param: payload.error.param });
      return;
    }
    const apiKey = apiKeyFromContext(c);
    keyId = apiKey.id;
    previousResponseId = payload.previous_response_id ?? undefined;
    const requestStartedAt = Date.now();
    const services = openAIResponsesServices({
      requestBody: null,
      runtimeLocation: getRuntimeLocation(c.req.raw),
      serverSecret: apiKey.serverSecret,
    }, (startedAt, store) => session.createStore(apiKey, startedAt, store), requestStartedAt);
    const http = initialHttpFacts(c);
    const handle = startPipeline(openAIResponsesClientPipeline, {
      ...http,
      'request.http': move({ ...http['request.http'], method: 'WS', body: bytes }),
      'request.ws.responseId': turn.responseId,
      ...openAIResponsesRequestFacts(payload, 'generate', requestStartedAt),
    }, services, signal, openPipelineRecorder(c, apiKey.id));
    backgroundScheduler(handle.done);

    const facts = await handle.result;
    const head = facts['response.http'];
    const outcome = facts['response.openaiResponses'];
    if (outcome.kind === 'error') {
      if (isClosed() || signal.aborted) return;
      const status = head?.status ?? 502;
      const retryAfter = head === null ? undefined : getHeader(head.headers, 'retry-after');
      const { cause } = outcome;
      const body = head === null && cause !== undefined
        ? serverErrorEnvelope(isHttpStreamError(cause) ? cause.cause : cause)
        : normalizeErrorBody(outcome.error, status);
      fail(status, body, typeof retryAfter === 'string' ? retryAfter : undefined);
      return;
    }
    if (outcome.kind === 'result') throw new TypeError('OpenAI Responses WebSocket generation returned a scalar');
    const delivered = await deliverOpenAIResponsesWebSocket({
      socket, eventId, turn, isClosed, model: payload.model, stream: outcome.stream, abortRun: () => { handle.root.abort(); },
    });
    if (!delivered) evict();
  } catch (error) {
    if (error instanceof WebSocketClientMessageError) {
      fail(400, { type: 'invalid_request_error', code: 'invalid_request_error', message: error.message });
      return;
    }
    if (isClosed()) throw error;
    fail(500, serverErrorEnvelope(error));
  }
};

class WebSocketClientMessageError extends Error {}

const wsDataToBytes = (data: unknown): Uint8Array => {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new WebSocketClientMessageError(`Unsupported WebSocket message data: ${typeof data}`);
};

const validateClientMessage = (parsed: unknown): OpenAIResponsesWebSocketClientEvent => {
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
    throw new WebSocketClientMessageError('WebSocket message must be a JSON object with a string type.');
  }
  return parsed as OpenAIResponsesWebSocketClientEvent;
};

type WebSocketStreamItem = Result<OpenAIResponsesStreamEventEx, ProtocolStreamError>;

const deliverOpenAIResponsesWebSocket = async ({
  socket, eventId, turn, isClosed, model, stream, abortRun,
}: {
  readonly socket: OpenAIResponsesWebSocketSocket;
  readonly eventId: string | undefined;
  readonly turn: ActiveOpenAIResponsesWebSocketTurn;
  readonly isClosed: () => boolean;
  readonly model: string;
  readonly stream: ManagedStream<OpenAIResponsesStreamEventEx, ProtocolStreamError>;
  readonly abortRun: () => void;
}): Promise<boolean> => {
  const { signal } = turn.abortController;
  const sequence = createDownstreamSequence();
  const iterator = stream[Symbol.asyncIterator]();
  let pending: Promise<WsFrameRaceResult> | undefined = pendingWsFrameResult(iterator.next());
  let terminal: OpenAIResponsesStreamEventEx | undefined;
  let streamed = false;
  let failed = false;
  let streamFailure: ProtocolStreamError | undefined;
  let abandoned = false;

  turn.requestInterrupt = interruptEventId => {
    turn.interrupted = true;
    sendJson(socket, {
      type: 'response.interrupt.accepted',
      response_id: turn.responseId,
      sequence_number: sequence.take(),
    }, interruptEventId);
    const requestedAt = Date.now();
    turn.interruptWaitWarning = setTimeout(() => {
      console.warn('Floway: Responses WebSocket interrupt is still waiting for the upstream stream to stop after abort', {
        responseId: turn.responseId,
        model,
        waitedMs: Date.now() - requestedAt,
      });
    }, INTERRUPT_UPSTREAM_ABORT_WARNING_MS);
    turn.abortController.abort(new OpenAIResponsesInterrupted());
  };

  const cancelled = (): boolean => (signal.aborted && !turn.interrupted) || isClosed();
  const stop = (): void => {
    abandoned = true;
    abortRun();
  };
  try {
    while (pending !== undefined) {
      if (!abandoned && cancelled()) stop();
      // Workers' WebSocket does not expose server ping frames. The text
      // heartbeat also rearms Codex's application-level idle timeout.
      // https://github.com/cloudflare/workerd/blob/26b5461b7dcc640bb16072f1ba6f2c6df82572ba/src/workerd/api/web-socket.h#L346-L394
      // https://github.com/openai/codex/blob/e6cfd40c3f444a5eeab01db70f48961a/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L695-L699
      const next = abandoned || terminal !== undefined || streamFailure !== undefined ? await pending : await nextFrameOrKeepAlive(pending);
      if (next.type === 'keep-alive') {
        if (streamed && !sendJson(socket, { type: KEEP_ALIVE_EVENT_TYPE, sequence_number: sequence.take() }, eventId)) stop();
        continue;
      }
      pending = undefined;
      if (next.type === 'next-error') throw next.error;
      if (next.result.done) break;

      const item = next.result.value;
      pending = pendingWsFrameResult(iterator.next());
      if (abandoned || terminal !== undefined || streamFailure !== undefined) continue;
      if (!item.ok) {
        streamFailure = item.error;
        continue;
      }

      const event = item.value;
      failed ||= event.type === 'error' || event.type === 'response.failed';
      if (event.type === 'response.created') turn.created = true;
      if (isOpenAIResponsesTerminalEvent(event)) {
        terminal = event;
        turn.terminal = true;
        abortRun();
        continue;
      }
      if (!sendJson(socket, sequence.renumber(event), eventId)) {
        stop();
        continue;
      }
      streamed = true;
    }
    if (abandoned || cancelled()) return false;
    if (streamFailure !== undefined) {
      sendError(socket, 502, serverErrorEnvelope(streamFailure.cause), eventId);
      return false;
    }
    if (terminal === undefined) {
      if (!failed) sendError(socket, 502, serverErrorEnvelope(new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE)), eventId);
      turn.terminal = true;
      return false;
    }
    const sent = sendJson(socket, sequence.renumber(terminal), eventId);
    return sent && !failed;
  } finally {
    turn.requestInterrupt = undefined;
    if (turn.interruptWaitWarning !== undefined) {
      clearTimeout(turn.interruptWaitWarning);
      turn.interruptWaitWarning = undefined;
    }
    if (pending !== undefined) {
      abortRun();
      let next = await pending;
      while (next.type === 'frame' && !next.result.done) next = await pendingWsFrameResult(iterator.next());
      if (next.type === 'next-error') throw next.error;
    }
  }
};

type WsFrameRaceResult =
  | { type: 'frame'; result: IteratorResult<WebSocketStreamItem> }
  | { type: 'next-error'; error: unknown }
  | { type: 'keep-alive' };

const pendingWsFrameResult = (pendingNext: Promise<IteratorResult<WebSocketStreamItem>>): Promise<WsFrameRaceResult> =>
  pendingNext.then(
    (result): WsFrameRaceResult => ({ type: 'frame', result }),
    (error): WsFrameRaceResult => ({ type: 'next-error', error }),
  );

// The interval is the one already shared with SSE rather than a WebSocket
// constant of its own. Widening the gap between server data frames on a
// dropping path put the boundary between 400 s, which still held the socket
// open, and 500 s, which did not, so 15 s is far more frequent than the
// mechanism needs. It is kept because widening it buys nothing: a keep-alive
// is ~70 bytes, and the earliest unprotected idle teardown seen on that same
// path was 215.8 s, so an interval chosen for economy would spend a real
// margin against a stochastic teardown to save nothing.
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

interface DownstreamSequence {
  renumber(event: OpenAIResponsesStreamEventEx): OpenAIResponsesStreamEventEx;
  take(): number;
}

// A WebSocket turn shares one sequence space with the streaming-HTTP events it
// carries, so a keep-alive cannot sit outside that numbering: it takes a real
// slot and every later event is shifted past it. The number is always present
// and always numeric, because a resuming openai-python client compares it with
// `>` against its `starting_after` cursor and `None` there raises a TypeError.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L117
// https://github.com/openai/openai-python/blob/3844843c277f42b0b18beaa58152cfda61df524a/src/openai/lib/streaming/responses/_responses.py#L59
//
// Upstream numbering is left untouched until the first keep-alive, and a
// keep-alive can only follow an event that already went out, so the slot it
// takes is always known.
const createDownstreamSequence = (): DownstreamSequence => {
  let shift = 0;
  let next = 0;
  return {
    renumber: event => {
      if (event.sequence_number === undefined) return event;
      const sequenceNumber = event.sequence_number + shift;
      next = sequenceNumber + 1;
      return { ...event, sequence_number: sequenceNumber };
    },
    take: () => {
      shift += 1;
      const taken = next;
      next += 1;
      return taken;
    },
  };
};

const serverErrorEnvelope = (cause: unknown): Record<string, unknown> => {
  const error = toInternalDebugError(cause);
  return { type: error.type, code: error.type, message: error.message, provider_specific_fields: internalDebugErrorFields(error) };
};

const normalizeErrorBody = (body: unknown, status: number): Record<string, unknown> => {
  const source = isJsonObject(body) ? isJsonObject(body.error) ? body.error : body : {};
  const type = typeof source.type === 'string' ? source.type : status >= 500 ? 'server_error' : 'invalid_request_error';
  const message = typeof source.message === 'string' ? source.message : `OpenAI Responses request failed with status ${status}.`;
  return { ...source, type, code: typeof source.code === 'string' ? source.code : type, message };
};

// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L166
const sendError = (
  socket: OpenAIResponsesWebSocketSocket,
  status: number,
  error: Record<string, unknown>,
  eventId?: string,
  retryAfter?: string,
): void => {
  // Codex reads retry hints from the WS envelope after the HTTP upgrade.
  // https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L756-L768
  const headers = retryAfter === undefined ? undefined : { 'retry-after': retryAfter };
  sendJson(socket, { type: 'error', status, error, headers }, eventId);
};

const sendJson = (socket: OpenAIResponsesWebSocketSocket, value: unknown, eventId?: string): boolean => {
  if (socket.readyState !== 1) return false;
  const payload = eventId === undefined || !value || typeof value !== 'object' ? value : { ...value, event_id: eventId };
  const text = JSON.stringify(payload);
  try {
    socket.send(text);
    return true;
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'InvalidStateError') throw error;
    return false;
  }
};
