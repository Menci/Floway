import type { Context } from 'hono';

import { createOpenAIResponsesWsSession } from './items/store.ts';
import { openaiResponsesWebSocketEntry } from './pipeline/ingress.ts';
import { OpenAIResponsesInterruption } from './pipeline/interruption.ts';
import { OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE } from './response-headers.ts';
import { createOpenAIResponsesResponseId } from './response-id.ts';
import { openDumpAccumulator, type DumpAccumulator } from '../../../dump/accumulator.ts';
import { recordSelectedDumpMetadata } from '../../../dump/selected-usage.ts';
import { apiKeyFromContext, authenticateApiKey, userFromContext, type AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { getRuntimeLocation } from '../../../runtime/runtime-info.ts';
import type { UsageObservation } from '../../pipeline/compute-usage.ts';
import type { SelectedCandidate } from '../../pipeline/facts.ts';
import { createGatewayServices } from '../../pipeline/services.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS } from '../../shared/sse.ts';
import { openAIResponsesFailureEvents } from '../pipeline/stream-error.ts';
import { getHeader } from '@floway-dev/http';
import { run, type Result } from '@floway-dev/pipeline';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { eventFrame, isJsonObject } from '@floway-dev/protocols/common';
import { isOpenAIResponsesTerminalEvent, OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE, openaiResponsesResultToEvents, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { internalDebugErrorFields, toInternalDebugError, type ProtocolStreamError } from '@floway-dev/upstream';

interface WorkerWebSocket extends WebSocket {
  accept(): void;
}

interface OpenAIResponsesWebSocketSocket {
  readonly readyState: number;
  send(data: string): void;
}

const UTF8_ENCODER = new TextEncoder();

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

interface InterruptMessage {
  readonly event_id?: unknown;
  readonly response_id?: unknown;
  readonly mode?: unknown;
}

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

  // A Workers message callback cannot extend the completed upgrade fetch.
  // Register one lifetime promise while the upgrade can still call waitUntil.
  // Track the queue itself so close cannot finish the lifetime before the last
  // turn has handed off its dump and runtime drain tasks.
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
      if (control !== undefined) {
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
            abortController.abort();
            if (activeAbortController === abortController) activeAbortController = undefined;
            if (activeTurn === turn) activeTurn = undefined;
            if (turn.terminal) terminalResponseIds.add(turn.responseId);
          }
        })
        // WS-specific top-level: Hono's onError never runs for callbacks fired off
        // an open socket, so we serialize the error inline as the spec's
        // WebSocket error envelope. (HTTP entries let onError handle the same case.)
        .catch(error => {
          if (!closed) sendError(socket, 500, serverErrorEnvelope(error));
        });
      sessionScheduler(queue);
    },
  };
};

const parseControlMessage = (data: unknown): InterruptMessage | undefined => {
  try {
    const message: unknown = JSON.parse(new TextDecoder().decode(wsDataToBytes(data)));
    return isJsonObject(message) && message.type === 'response.interrupt' ? message : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof WebSocketClientMessageError) return undefined;
    throw error;
  }
};

// Codex sends this control frame only after `response.created`, targeting the
// observed response ID and requesting `discard_partial_items`.
// https://github.com/openai/codex/blob/12de0e395d3313bc564190d983cb4f5acf0be713/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L688-L704
const handleInterruptMessage = async (
  message: InterruptMessage,
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
  sessionScheduler: BackgroundScheduler,
): Promise<void> => {
  const controller = turn.abortController;
  const signal = controller.signal;
  let eventId: string | undefined;
  let dump: DumpAccumulator | null = null;
  let evict = (): void => {};
  let status = 500;
  let candidate: SelectedCandidate | undefined;
  let usage: Promise<UsageObservation> | undefined;
  const fail = (failureStatus: number, error: Record<string, unknown>, retryAfter?: string): void => {
    status = failureStatus;
    evict();
    sendError(socket, status, error, eventId, dump, retryAfter);
  };

  try {
    const bytes = wsDataToBytes(data);
    if (!await authenticateApiKey(c, authenticatedRawKey)) {
      fail(401, { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API key.' });
      return;
    }
    if (isClosed()) return;

    const message = parseClientMessage(bytes);
    eventId = typeof message.event_id === 'string' ? message.event_id : undefined;
    const source = isJsonObject(message.response) ? message.response : message;
    const previous = source.previous_response_id;
    const apiKey = apiKeyFromContext(c);
    // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L127
    evict = () => {
      if (message.type === 'response.create' && typeof previous === 'string') session.evictSnapshot(apiKey.id, previous);
    };

    const startedAt = Date.now();
    const request = c.req.raw;
    dump = openDumpAccumulator(c, 'WS', apiKey, { bytes, streamError: null }, sessionScheduler, true);
    const services = createGatewayServices({
      apiKey,
      subject: userFromContext(c),
      runtimeLocation: getRuntimeLocation(request),
      dump,
      openaiResponsesStore: (at, store) => session.createStore(apiKey, at, store),
    });
    const running = run(openaiResponsesWebSocketEntry, {
      http: { url: request.url, method: request.method, headers: [...request.headers], body: bytes },
      'serve.startedAt': startedAt,
      'ws.message': message,
      ...(eventId === undefined ? {} : { 'ws.eventId': eventId }),
      'ws.responseId': turn.responseId,
    }, { services, signal, waitUntil: sessionScheduler });
    let answer: Awaited<typeof running.result> | undefined;
    let abortReason: unknown;

    try {
      answer = await running.result;
      candidate = answer.candidate;
      if (dump !== null && candidate !== undefined && answer.usage !== undefined) {
        usage = running.read(answer.usage);
        // The archive awaits the original dependency after delivery.
        void usage.catch(() => undefined);
      }
      if (isClosed()) {
        status = 499;
        dump?.failed('Responses WebSocket closed before delivery');
        return;
      }

      const outcome = answer.openaiResponses;
      if (outcome.kind === 'error') {
        const http = answer.http;
        const failureStatus = http?.status ?? (outcome.source === 'local' ? 499 : 502);
        const retryAfter = http === null ? undefined : getHeader(http.headers, 'retry-after');
        fail(failureStatus, normalizeErrorBody(outcome.error, failureStatus), typeof retryAfter === 'string' ? retryAfter : undefined);
        return;
      }
      if (outcome.kind !== 'stream') throw new TypeError('OpenAI Responses WebSocket generation returned a scalar success');

      const cursor = running.read(outcome.stream);
      const sequence = createDownstreamSequence();
      const failures = createFailedTurnDelivery();
      const send = (event: OpenAIResponsesStreamEventEx): boolean => sendJson(socket, sequence.renumber(event), eventId, dump);
      let streamed = false;
      let terminal: OpenAIResponsesStreamEventEx | undefined;
      turn.requestInterrupt = (interruptEventId): void => {
        if (turn.interrupted || turn.terminal || !turn.created) return;
        turn.interrupted = true;
        sendJson(socket, {
          type: 'response.interrupt.accepted',
          response_id: turn.responseId,
          sequence_number: sequence.take(),
        }, interruptEventId, dump);
        const interruptRequestedAt = Date.now();
        turn.interruptWaitWarning = setTimeout(() => {
          console.warn('Floway: Responses WebSocket interrupt is still waiting for the upstream stream to stop after abort', {
            responseId: turn.responseId,
            model: source.model,
            waitedMs: Date.now() - interruptRequestedAt,
          });
        }, INTERRUPT_UPSTREAM_ABORT_WARNING_MS);
        controller.abort(new OpenAIResponsesInterruption());
      };

      while (!isClosed()) {
        const next = await nextWebSocketFrame(cursor.next(), () =>
          !isClosed() && (!streamed || sendJson(socket, { type: KEEP_ALIVE_EVENT_TYPE, sequence_number: sequence.take() }, eventId, dump)));
        if (next.type === 'next-error') throw next.error;
        if (next.type === 'disconnected' || isClosed()) break;

        const item = next.result;
        if (item.done) {
          if (terminal === undefined) throw new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE);
          if (!send(terminal)) break;
          turn.terminal = true;
          status = 200;
          return;
        }
        if (!item.value.ok) {
          const error = item.value.error;
          abortReason = error.cause;
          status = error.kind === 'abort' ? 499 : 500;
          evict();
          if (error.kind !== 'abort') {
            const delivered = failures.frames(error);
            if (delivered.length === 0) fail(status, serverErrorEnvelope(error.cause));
            for (const { event, synthetic } of delivered) {
              if (!send(event)) break;
              if (synthetic) dump?.frame(eventFrame(event));
            }
          } else {
            dump?.failed(error.cause);
          }
          turn.terminal = true;
          return;
        }
        const event = item.value.value;
        if (isOpenAIResponsesTerminalEvent(event)) {
          terminal = event;
          turn.terminal = true;
          continue;
        }
        if (terminal !== undefined || !send(event)) break;
        streamed = true;
        failures.observe(event);
        if (event.type === 'response.created') turn.created = true;
      }

      status = 499;
      evict();
      dump?.failed('Responses WebSocket closed before delivery');
    } catch (error) {
      abortReason = error;
      throw error;
    } finally {
      controller.abort(abortReason);
      if (answer !== undefined) running.discard(answer);
    }
  } catch (error) {
    if (error instanceof WebSocketClientMessageError) {
      fail(400, { type: 'invalid_request_error', code: 'invalid_request_error', message: error.message });
      return;
    }
    dump?.failed(error);
    if (isClosed()) {
      evict();
      console.error('[ws-turn]', error);
    } else {
      fail(500, serverErrorEnvelope(error));
    }
  } finally {
    turn.requestInterrupt = undefined;
    if (turn.interruptWaitWarning !== undefined) {
      clearTimeout(turn.interruptWaitWarning);
      turn.interruptWaitWarning = undefined;
    }
    if (dump !== null) dump.finalize(status, [], candidate === undefined ? undefined : recordSelectedDumpMetadata(dump, candidate, usage));
  }
};

class WebSocketClientMessageError extends Error {}

const wsDataToBytes = (data: unknown): Uint8Array => {
  if (typeof data === 'string') return UTF8_ENCODER.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new WebSocketClientMessageError(`Unsupported WebSocket message data: ${typeof data}`);
};

const parseClientMessage = (bytes: Uint8Array): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new WebSocketClientMessageError(`WebSocket message must be valid JSON: ${error.message}`, { cause: error });
  }
  if (!isJsonObject(parsed)) throw new WebSocketClientMessageError('WebSocket message must be a JSON object with a string type.');
  return parsed;
};

type WebSocketFrame =
  | { type: 'frame'; result: IteratorResult<Result<OpenAIResponsesStreamEventEx, ProtocolStreamError>> }
  | { type: 'next-error'; error: unknown }
  | { type: 'disconnected' };

const nextWebSocketFrame = async (
  read: Promise<IteratorResult<Result<OpenAIResponsesStreamEventEx, ProtocolStreamError>>>,
  keepAlive: () => boolean,
): Promise<WebSocketFrame> => {
  let wake: (() => void) | undefined;
  let value: WebSocketFrame | undefined;
  const settle = (result: WebSocketFrame): void => {
    value = result;
    wake?.();
  };
  void read.then(result => settle({ type: 'frame', result }), error => settle({ type: 'next-error', error }));
  while (value === undefined) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = undefined;
    // Cloudflare can close idle connections. This extension follows the
    // session's first delivered event and takes one slot in its sequence.
    // https://developers.cloudflare.com/network/websockets/#idle-timeout
    if (value === undefined && !keepAlive()) return { type: 'disconnected' };
  }
  return value;
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

const isResponseLifecycle = (event: OpenAIResponsesStreamEventEx): boolean =>
  event.type === 'response.queued' || event.type === 'response.created' || event.type === 'response.in_progress';

const createFailedTurnDelivery = () => {
  const lifecycle = new Set<OpenAIResponsesStreamEventEx['type']>();
  let structured = false;
  let next = 0;
  const number = (event: OpenAIResponsesStreamEventEx, sequenceNumber = event.sequence_number ?? next): OpenAIResponsesStreamEventEx => {
    next = Math.max(next, sequenceNumber + 1);
    return sequenceNumber === event.sequence_number ? event : { ...event, sequence_number: sequenceNumber };
  };
  return {
    observe(event: OpenAIResponsesStreamEventEx) {
      if (event.sequence_number !== undefined) next = Math.max(next, event.sequence_number + 1);
      if (isResponseLifecycle(event)) lifecycle.add(event.type);
      else if (event.type !== 'error') structured = true;
    },
    frames(error: ProtocolStreamError): { event: OpenAIResponsesStreamEventEx; synthetic: boolean }[] {
      const frames: { event: OpenAIResponsesStreamEventEx; synthetic: boolean }[] = [];
      const { notification, failed } = openAIResponsesFailureEvents(error);
      if (notification !== undefined) frames.push({ event: number(notification), synthetic: false });
      if (failed === undefined) return frames;

      // Short Responses streams can carry the rest of the lifecycle only in
      // their terminal resource. The error notification comes before expansion.
      if (structured || !isJsonObject(failed.response) || !Array.isArray(failed.response.output)) {
        frames.push({ event: number(failed), synthetic: false });
        return frames;
      }
      for (const { event } of openaiResponsesResultToEvents(failed.response, { terminal: 'response.failed' })) {
        if (lifecycle.has(event.type)) continue;
        frames.push({ event: number(event, next), synthetic: event.type !== 'response.failed' });
      }
      return frames;
    },
  };
};

const serverErrorEnvelope = (error: unknown): Record<string, unknown> => {
  const debug = toInternalDebugError(error);
  return { type: debug.type, code: debug.type, message: debug.message, provider_specific_fields: internalDebugErrorFields(debug) };
};

const normalizeErrorBody = (body: unknown, status: number): Record<string, unknown> => {
  const source = isJsonObject(body) ? isJsonObject(body.error) ? body.error : body : {};
  const type = typeof source.type === 'string' ? source.type : status >= 500 ? 'server_error' : 'invalid_request_error';
  const message = typeof source.message === 'string' ? source.message
    : typeof body === 'string' ? body : `OpenAI Responses request failed with status ${status}.`;
  return { ...source, type, code: typeof source.code === 'string' ? source.code : type, message };
};

// "WebSocket failures MUST be sent as a JSON `error` envelope with a `status`
// code and an `error.code`."
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L166
// The `WebSocketErrorEvent` schema requires `type`, `status`, and `error` and
// leaves the top level open, so `sendJson` may add `event_id` beside them.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/schema/components/schemas/WebSocketErrorEvent.json#L47
const sendError = (
  socket: OpenAIResponsesWebSocketSocket,
  status: number,
  error: Record<string, unknown>,
  eventId?: string,
  dump?: DumpAccumulator | null,
  retryAfter?: string,
): void => {
  // Codex reads retry hints from the WS envelope after the HTTP upgrade.
  // https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L756-L768
  const headers = retryAfter === undefined ? undefined : { 'retry-after': retryAfter };
  sendJson(socket, { type: 'error', status, error, headers }, eventId, dump);
};

const sendJson = (
  socket: OpenAIResponsesWebSocketSocket,
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
