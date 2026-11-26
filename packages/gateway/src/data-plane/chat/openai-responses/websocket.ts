import type { Context } from 'hono';

import { openAIResponsesStreamFailure } from './collect.ts';
import { OpenAIResponsesInterruption } from './interruption.ts';
import { createOpenAIResponsesWsSession } from './items/store.ts';
import { openAIResponsesWebSocketPayload, parseOpenAIResponsesJson } from './parse.ts';
import { OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE } from './response-headers.ts';
import { createOpenAIResponsesResponseId } from './response-id.ts';
import { openAIResponsesFailureEvents } from './stream-error.ts';
import { apiKeyFromContext, authenticateApiKey, userFromContext, type AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { getRuntimeLocation } from '../../../runtime/runtime-info.ts';
import { openRequestArchive } from '../../pipeline/archive.ts';
import type { UsageObservation } from '../../pipeline/compute-usage.ts';
import type { GatewayPipelineFacts, ResponseOutcome } from '../../pipeline/facts.ts';
import { httpRequestFact } from '../../pipeline/http.ts';
import { createGatewayServices } from '../../pipeline/services.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS } from '../../shared/sse.ts';
import { openAIResponsesWebSocketIngress } from '../pipeline.ts';
import { getHeader } from '@floway-dev/http';
import { run, type Result } from '@floway-dev/pipeline';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { isJsonObject } from '@floway-dev/protocols/common';
import { isOpenAIResponsesTerminalEvent, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { internalDebugErrorFields, toInternalDebugError, type ProtocolStreamError } from '@floway-dev/provider';

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

interface Turn {
  responseId: string;
  controller: AbortController;
  terminal: boolean;
  interrupt?(eventId: string | undefined): void;
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
  const credential = apiKeyFromContext(c).key;
  const session = createOpenAIResponsesWsSession();
  const terminalIds = new Set<string>();
  const pendingWork = new Set<Promise<unknown>>();
  const sessionClosed = Promise.withResolvers<void>();
  let closed = false;
  let active: Turn | undefined;
  let queue = Promise.resolve();

  const waitUntil: BackgroundScheduler = promise => {
    const tracked: Promise<unknown> = Promise.resolve(promise)
      .catch(error => console.error('Floway Responses WebSocket background task failed', error))
      .finally(() => { pendingWork.delete(tracked); });
    pendingWork.add(tracked);
  };
  // Cloudflare accepts waitUntil during the upgrade fetch. Track message and
  // archive work through one upgrade-lifetime promise, including late tasks.
  backgroundSchedulerFromContext(c)((async () => {
    await sessionClosed.promise;
    while (pendingWork.size > 0) await Promise.allSettled([...pendingWork]);
  })());

  const close = (): void => {
    closed = true;
    active?.controller.abort(new Error('Responses WebSocket disconnected'));
    sessionClosed.resolve();
  };
  return {
    onClose: close,
    onError: close,
    onMessage: ({ data }, socket) => {
      const bytes = typeof data === 'string' ? UTF8_ENCODER.encode(data)
        : data instanceof ArrayBuffer ? new Uint8Array(data)
          : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      const parsed = parseOpenAIResponsesJson(bytes);
      const message = 'value' in parsed && isJsonObject(parsed.value) ? parsed.value : undefined;
      const eventId = typeof message?.event_id === 'string' ? message.event_id : undefined;
      if (message?.type === 'response.interrupt') {
        waitUntil((async () => {
          if (!await authenticateApiKey(c, credential)) {
            sendJson(socket, websocketError(401, { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API key.' }), eventId);
            return;
          }
          const id = message.response_id;
          if (typeof id !== 'string' || id.length === 0 || message.mode !== 'discard_partial_items') {
            sendJson(socket, websocketError(400, { message: "response.interrupt requires response_id and mode='discard_partial_items'." }), eventId);
          } else if (terminalIds.has(id) || (active?.responseId === id && active.terminal)) {
            return;
          } else if (active?.responseId === id && active.interrupt !== undefined) {
            active.interrupt(eventId);
          } else {
            sendJson(socket, websocketError(400, { code: 'response_not_found', message: 'The response to interrupt is not active on this connection.' }), eventId);
          }
        })());
        return;
      }

      queue = queue.then(async () => {
        if (closed) return;
        const turn: Turn = { responseId: createOpenAIResponsesResponseId(), controller: new AbortController(), terminal: false };
        active = turn;
        try {
          await handleWebSocketTurn({ c, socket, session, credential, bytes, message, eventId, turn, waitUntil, isClosed: () => closed });
        } finally {
          if (turn.terminal) terminalIds.add(turn.responseId);
          active = undefined;
        }
      }).catch(error => {
        if (!closed) sendJson(socket, websocketError(500, serverErrorEnvelope(error)), eventId);
      });
      waitUntil(queue);
    },
  };
};

interface TurnOptions {
  c: AuthedContext;
  socket: OpenAIResponsesWebSocketSocket;
  session: ReturnType<typeof createOpenAIResponsesWsSession>;
  credential: string;
  bytes: Uint8Array | null;
  message: Record<string, unknown> | undefined;
  eventId: string | undefined;
  turn: Turn;
  waitUntil: BackgroundScheduler;
  isClosed(): boolean;
}

const handleWebSocketTurn = async ({ c, socket, session, credential, bytes, message, eventId, turn, waitUntil, isClosed }: TurnOptions): Promise<void> => {
  if (!await authenticateApiKey(c, credential)) {
    sendJson(socket, websocketError(401, { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API key.' }));
    return;
  }
  if (bytes === null) {
    sendJson(socket, websocketError(400, { message: 'Unsupported WebSocket message data.' }), eventId);
    return;
  }

  const startedAt = Date.now();
  const apiKey = apiKeyFromContext(c);
  const user = userFromContext(c);
  const runtimeLocation = getRuntimeLocation(c.req.raw);
  const request = message === undefined ? undefined : openAIResponsesWebSocketPayload(message);
  const previous = request?.previous_response_id;
  // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L127
  const evict = (): void => {
    if (typeof previous === 'string') session.evictSnapshot(apiKey.id, previous);
  };
  const entry = { ...await httpRequestFact(c.req.raw), body: bytes };
  const archive = apiKey.dumpRetentionSeconds === null
    ? undefined
    : openRequestArchive(apiKey.id, { ...entry, method: 'WS' }, startedAt, waitUntil);
  let candidate: GatewayPipelineFacts['response.candidate'] | undefined;
  let requestedModel: string | undefined;
  let verdict: ResponseOutcome | undefined;
  let usage: Promise<UsageObservation | undefined> = Promise.resolve(undefined);
  let performance: Promise<{ ttftMs: number | null } | undefined> = Promise.resolve(undefined);
  let responseBytes = 0;
  let status = 200;
  let failure: unknown;
  const stop = (): void => {
    status = 499;
    failure = new Error('Responses WebSocket stopped reading the turn');
    turn.controller.abort(failure);
  };
  const send = (payload: unknown, id = eventId): boolean => {
    const sent = sendJson(socket, payload, id);
    if (sent === undefined) return false;
    responseBytes += sent;
    return true;
  };

  let interruptWarning: ReturnType<typeof setTimeout> | undefined;
  try {
    const services = await createGatewayServices(runtimeLocation, apiKey);
    const running = run(openAIResponsesWebSocketIngress, {
      'request.http': entry,
      'request.auth.apiKeyId': apiKey.id,
      'request.auth.userId': user.id,
      'request.auth.isAdmin': user.isAdmin,
      'request.auth.upstreamIds': apiKey.upstreamIds,
      'request.auth.randomizeUpstreams': apiKey.randomizeUpstreams,
      'request.ws.responseId': turn.responseId,
      'serve.startedAt': startedAt,
      'serve.runtimeLocation': runtimeLocation,
    }, {
      services: { ...services, openaiResponsesStore: (at, store) => session.createStore(apiKey, at, store) },
      signal: turn.controller.signal,
      waitUntil: archive?.waitUntil ?? waitUntil,
      ...(archive === undefined ? {} : { events: archive.events }),
    });
    archive?.finish(running.done);
    const answer = await running.result;
    candidate = answer['response.candidate'];
    requestedModel = answer['response.requestedModel'];
    const observed = answer['response.usage'];
    if (observed) {
      usage = running.read(observed);
      void usage.catch(() => undefined);
    }
    const measured = answer['response.performance'];
    if (measured) {
      performance = running.read(measured);
      void performance.catch(() => undefined);
    }

    const http = answer['response.http'];
    const body = http?.body;
    if (body && !(body instanceof Uint8Array)) running.discard(body);
    const outcome = answer['response.openaiResponses'];
    if (outcome.kind === 'error') {
      verdict = outcome.source;
      turn.controller.abort();
      await running.done;
      status = http?.status ?? (outcome.source === 'local' ? 499 : 502);
      if (status >= 400) evict();
      const retryAfter = http && getHeader(http.headers, 'retry-after');
      if (!isClosed()) send(websocketError(status, outcome.error, typeof retryAfter === 'string' ? retryAfter : undefined));
      return;
    }
    if (outcome.kind !== 'stream') throw new TypeError('OpenAI Responses WebSocket generation returned a scalar success');

    const sequence = createDownstreamSequence();
    const cursor = running.read(outcome.stream);
    let sourceEnded = false;
    let streamed = false;
    let terminal: OpenAIResponsesStreamEventEx | undefined;
    try {
      while (!isClosed()) {
        const next = await nextWebSocketFrame(cursor.next(), () =>
          !isClosed() && (!streamed || send({ type: KEEP_ALIVE_EVENT_TYPE, sequence_number: sequence.take() })));
        if (next.type === 'disconnected' || isClosed()) break;
        if (next.type === 'next-error') {
          sourceEnded = true;
          throw next.error;
        }
        const item = next.result;
        if (item.done) {
          verdict = 'success';
          sourceEnded = true;
          turn.controller.abort();
          await running.done;
          if (terminal === undefined) throw new Error('OpenAI Responses WebSocket stream ended without a terminal response');
          if (!send(sequence.renumber(terminal))) stop();
          turn.terminal = true;
          return;
        }
        if (!item.value.ok) {
          const error = item.value.error;
          verdict = error.kind === 'abort' ? 'local' : 'upstream';
          turn.controller.abort();
          await cursor.next();
          sourceEnded = true;
          await running.done;
          status = openAIResponsesStreamFailure(error).status;
          evict();
          const { notification, failed } = openAIResponsesFailureEvents(error);
          if (notification) send(sequence.renumber(notification));
          if (failed) send(sequence.renumber(failed));
          if (!notification && !failed && !isClosed()) send(websocketError(status, serverErrorEnvelope(error.cause)));
          turn.terminal = true;
          return;
        }
        const event = item.value.value;
        if (isOpenAIResponsesTerminalEvent(event)) {
          terminal = event;
          turn.terminal = true;
          continue;
        }
        if (terminal !== undefined || !send(sequence.renumber(event))) break;
        streamed = true;
        if (event.type === 'response.created') {
          turn.interrupt = id => {
            if (turn.controller.signal.aborted || turn.terminal) return;
            send({ type: 'response.interrupt.accepted', response_id: turn.responseId, sequence_number: sequence.take() }, id);
            interruptWarning = setTimeout(() => {
              console.warn('Floway Responses WebSocket interrupt is waiting for its upstream stream to stop', { responseId: turn.responseId });
            }, INTERRUPT_UPSTREAM_ABORT_WARNING_MS);
            turn.controller.abort(new OpenAIResponsesInterruption());
          };
        }
      }

      stop();
    } finally {
      if (!sourceEnded) {
        turn.controller.abort();
        running.discard(outcome.stream);
      }
    }
  } catch (error) {
    status = 500;
    failure = error;
    turn.controller.abort(error);
    evict();
    if (!isClosed()) send(websocketError(status, serverErrorEnvelope(error)));
  } finally {
    if (interruptWarning !== undefined) clearTimeout(interruptWarning);
    archive?.complete({
      status,
      responseBytes,
      candidate,
      requestedModel,
      usage,
      performance,
      ...(verdict === undefined ? {} : { outcome: Promise.resolve(verdict) }),
      ...(failure === undefined ? {} : { error: failure }),
    });
  }
};

type WebSocketFrame =
  | { type: 'frame'; result: IteratorResult<Result<OpenAIResponsesStreamEventEx, ProtocolStreamError>> }
  | { type: 'next-error'; error: unknown }
  | { type: 'disconnected' };

// The interval is the one already shared with SSE rather than a WebSocket
// constant of its own. Widening the gap between server data frames on a
// dropping path put the boundary between 400 s, which still held the socket
// open, and 500 s, which did not, so 15 s is far more frequent than the
// mechanism needs. It is kept because widening it buys nothing: a keep-alive
// is ~70 bytes, and the earliest unprotected idle teardown seen on that same
// path was 215.8 s, so an interval chosen for economy would spend a real
// margin against a stochastic teardown to save nothing.
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
      const sequenceNumber = Math.max(next, (event.sequence_number ?? next - shift) + shift);
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

// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L166
const websocketError = (status: number, body: unknown, retryAfter?: string) => {
  const value = isJsonObject(body) ? body : {};
  const error = isJsonObject(value.error) ? value.error : value;
  const type = typeof error.type === 'string' ? error.type : status >= 500 ? 'server_error' : 'invalid_request_error';
  return {
    type: 'error',
    status,
    error: {
      ...error,
      type,
      code: typeof error.code === 'string' ? error.code : type,
      message: typeof error.message === 'string' ? error.message : `OpenAI Responses request failed with status ${status}.`,
    },
    // https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L756-L768
    ...(retryAfter === undefined ? {} : { headers: { 'retry-after': retryAfter } }),
  };
};

const sendJson = (socket: OpenAIResponsesWebSocketSocket, value: unknown, eventId?: string): number | undefined => {
  if (socket.readyState !== 1) return undefined;
  const payload = eventId === undefined || !value || typeof value !== 'object' ? value : { ...value, event_id: eventId };
  const text = JSON.stringify(payload);
  try {
    socket.send(text);
  } catch {
    return undefined;
  }
  return UTF8_ENCODER.encode(text).byteLength;
};
