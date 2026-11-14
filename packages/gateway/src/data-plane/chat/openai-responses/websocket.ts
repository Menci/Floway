// The OpenAI Responses WebSocket transport: a second entry against the same chain `POST
// /v1/responses` runs. One `response.create` frame is one turn and one turn is one run, so
// nothing about a turn outlives the frame that opened it except what the connection itself
// holds — the session's item store and the ids a continuation may name.
//
// Entering the pipeline system takes no capability, so this handler opens a run exactly as a
// Hono route handler does. What it does not do is answer through `serveThrough`: that builds
// an HTTP `Response`, and a turn here writes its own frames to a socket, counts them, and
// closes its own recording.

import type { Context } from 'hono';

import { createOpenAIResponsesWebSocketTurn, type OpenAIResponsesWebSocketServices, type OpenAIResponsesWebSocketTurn } from './interrupt-websocket.ts';
import { createOpenAIResponsesWsSession, type OpenAIResponsesStatefulStore } from './items/store.ts';
import { openaiResponsesWebSocketPipeline } from './pipeline.ts';
import { openaiResponsesWebSocketInternalError, type OpenAIResponsesWebSocketExit } from './project-websocket.ts';
import { OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE } from './response-headers.ts';
import { openRunDump } from '../../../dump/run-sink.ts';
import type { RunDump } from '../../../dump/run-sink.ts';
import { apiKeyFromContext, authenticateApiKey, type AuthedContext } from '../../../middleware/auth.ts';
import type { ApiKey } from '../../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { prologueFor, type Ingress } from '../../pipeline/serve.ts';
import type { AttemptState } from '../../shared/gateway-ctx.ts';
import { takeRequestBody, type RequestBody } from '../../shared/request-body.ts';
import { type StreamCompletion } from '../../shared/sse.ts';
import type { ChatPrologue } from '../prologue.ts';
import { createChatGatewayCtxFromHono, type ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { SourceStreamState } from '../shared/source-stream-state.ts';
import { move, run } from '@floway-dev/pipeline';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { canonicalizeOpenAIResponsesPayload, isOpenAIResponsesTerminalEvent, type CanonicalOpenAIResponsesPayload, type ClientOpenAIResponsesStreamEvent, type OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';

interface WorkerWebSocket extends WebSocket {
  accept(): void;
}

interface OpenAIResponsesWebSocketSocket {
  readonly readyState: number;
  send(data: string): void;
}

const UTF8_ENCODER = new TextEncoder();

interface OpenAIResponsesWebSocketHandlers {
  onMessage(event: { readonly data: unknown }, socket: OpenAIResponsesWebSocketSocket): void;
  onClose(event: unknown, socket: OpenAIResponsesWebSocketSocket): void;
  onError(event: unknown, socket: OpenAIResponsesWebSocketSocket): void;
}

type OpenAIResponsesWebSocketUpgradeResolver = (
  c: Context,
  events: OpenAIResponsesWebSocketHandlers,
) => Response | Promise<Response>;

let _responsesWebSocketUpgradeResolver: OpenAIResponsesWebSocketUpgradeResolver | null = null;

export const initOpenAIResponsesWebSocketUpgradeResolver = (
  resolver: OpenAIResponsesWebSocketUpgradeResolver,
): void => {
  _responsesWebSocketUpgradeResolver = resolver;
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

export const openaiResponsesWebSocket = async (c: AuthedContext): Promise<Response> => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return Response.json({ error: 'Expected Upgrade: websocket' }, { status: 426 });
  }

  const events = createOpenAIResponsesWebSocketEvents(c);
  c.header(OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE);
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

const createOpenAIResponsesWebSocketEvents = (c: AuthedContext): OpenAIResponsesWebSocketHandlers => {
  // The upgrade authenticates the connection, but every response.create is a
  // separate data-plane request. Codex deliberately reuses one socket across
  // turns, so retain the presented credential and resolve it again before each
  // turn rather than freezing key/user policy at upgrade time.
  const authenticatedRawKey = apiKeyFromContext(c).key;
  const session = createOpenAIResponsesWsSession();
  let closed = false;
  let activeAbortController: AbortController | undefined;
  let activeTurn: OpenAIResponsesWebSocketTurn | undefined;
  const terminalResponseIds = new Set<string>();
  let queue = Promise.resolve();

  // ── Session-scoped BackgroundScheduler ──────────────────────────────────
  //
  // The runtime's default scheduler on Cloudflare is
  // `promise => c.executionCtx.waitUntil(promise)`. That call is only legal
  // during the fetch invocation; once the fetch handler returns the 101
  // upgrade, subsequent waitUntil calls made from message-event handlers
  // are silently dropped (the promise never runs, the isolate has no
  // registered reason to defer eviction for it). Every per-turn background
  // task — the dump write, the usage row, the performance sample, the drain —
  // would therefore lose its write, so this is the scheduler every turn's run
  // is opened with rather than the context's.
  //
  // Fix: give the run a scheduler that doesn't depend on the fetch's
  // execution context at all. `sessionScheduler` tracks the task in
  // `pendingWork`; the isolate stays alive throughout because we register
  // ONE lifetime promise up-front (while the fetch handler is still
  // running, so this waitUntil IS legal) that only resolves when
  // (WS closed ∧ pendingWork drained).
  //
  // The drain uses a `while (size > 0)` loop rather than a single
  // `Promise.allSettled(pendingWork)` snapshot: the in-flight message
  // handler running at close time may still enqueue a final write from its
  // finally/catch after `sessionClosed` resolves. The loop keeps going until
  // the Set is genuinely empty, which is bounded because `closed = true`
  // short-circuits future message handlers at the top of
  // `handleClientMessage`.
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
      // An interrupt targets the turn the queue is running, so it cannot wait behind it.
      const control = parseControlMessage(event.data);
      if (control !== undefined) {
        sessionScheduler(handleInterruptMessage(c, socket, control, authenticatedRawKey, () => activeTurn, terminalResponseIds));
        return;
      }
      queue = queue
        .then(async () => {
          if (closed) return;
          const abortController = new AbortController();
          const turn = createOpenAIResponsesWebSocketTurn(abortController);
          activeAbortController = abortController;
          activeTurn = turn;
          try {
            await handleClientMessage(c, socket, session, event.data, authenticatedRawKey, abortController, turn, () => closed, sessionScheduler);
          } finally {
            if (activeAbortController === abortController) activeAbortController = undefined;
            if (activeTurn === turn) activeTurn = undefined;
            if (turn.ended && turn.responseId !== undefined) terminalResponseIds.add(turn.responseId);
          }
        })
        // WS-specific top-level: Hono's onError never runs for callbacks fired off
        // an open socket, so we serialize the error inline as the spec's
        // WebSocket error envelope. (HTTP entries let onError handle the same case.)
        .catch(error => {
          if (!closed) sendError(socket, 500, openaiResponsesWebSocketInternalError(error));
        });
    },
  };
};

const parseControlMessage = (data: unknown): OpenAIResponsesWebSocketClientEvent | undefined => {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(wsDataToBytes(data))) as unknown;
    if (!parsed || typeof parsed !== 'object' || (parsed as { type?: unknown }).type !== 'response.interrupt') return undefined;
    return parsed as OpenAIResponsesWebSocketClientEvent;
  } catch {
    return undefined;
  }
};

// Codex sends this control frame only after `response.created`, targeting the
// observed response ID and requesting `discard_partial_items`.
// https://github.com/openai/codex/blob/12de0e395d3313bc564190d983cb4f5acf0be713/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L688-L704
const handleInterruptMessage = async (
  c: AuthedContext,
  socket: OpenAIResponsesWebSocketSocket,
  message: OpenAIResponsesWebSocketClientEvent,
  authenticatedRawKey: string,
  activeTurn: () => OpenAIResponsesWebSocketTurn | undefined,
  terminalResponseIds: ReadonlySet<string>,
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
  const responseId = message.response_id;
  if (typeof responseId !== 'string' || responseId.length === 0 || message.mode !== 'discard_partial_items') {
    sendError(socket, 400, {
      type: 'invalid_request_error',
      code: 'invalid_request_error',
      message: "response.interrupt requires response_id and mode='discard_partial_items'.",
    }, eventId);
    return;
  }
  // A duplicate, or one that crossed the turn's end on the wire, changes nothing. A turn that
  // broke off without ending is not one, and its response is no longer active.
  if (terminalResponseIds.has(responseId)) return;
  const turn = activeTurn();
  if (turn?.responseId !== responseId) {
    sendError(socket, 400, {
      type: 'invalid_request_error',
      code: 'response_not_found',
      message: 'The response to interrupt is not active on this connection.',
    }, eventId);
    return;
  }
  if (turn.interruption !== undefined || turn.ended) return;
  turn.interrupt({ responseId, eventId });
};

interface OpenAIResponsesWsTurnFailure {
  evict(): void;
  fail(status: number, error: Record<string, unknown>): void;
}

/**
 * A turn's own run.
 *
 * `openChatPrologue` reads the turn's shape off the Hono context, and a turn on this
 * transport shares none of that shape with the request that opened the socket. It is a `WS`
 * turn on a connection whose upgrade was a `GET`; its body is the frame that just arrived
 * rather than the upgrade's, which had none; it owns the abort controller the session cancels
 * it with; and its background work outlives the fetch that returned the 101, so the scheduler
 * it settles and records through is the session's rather than that fetch's. What it does not
 * differ in is the services a chat run is given, which is why it hands those back in the shape
 * every chat entry hands them over in.
 */
const openOpenAIResponsesWebSocketTurn = (
  c: AuthedContext,
  turn: {
    readonly payload: CanonicalOpenAIResponsesPayload;
    readonly body: RequestBody;
    readonly headers: Ingress['headers'];
    readonly downstreamAbortController: AbortController;
    readonly turn: OpenAIResponsesWebSocketTurn;
    readonly backgroundScheduler: BackgroundScheduler;
    readonly store: (apiKey: ApiKey, requestStartedAt: number) => OpenAIResponsesStatefulStore;
  },
): ChatPrologue & { readonly services: OpenAIResponsesWebSocketServices } => {
  // The frame is this turn's request body, so an operator reading the dashboard sees the
  // exact `response.create` that opened it, under its own `WS /v1/responses` row rather than
  // under the upgrade that carried it.
  const attempt: AttemptState = { timing: { firstOutputTokenAt: null, upstreamCallStartedAt: null }, telemetry: undefined };
  const dump = openRunDump(
    apiKeyFromContext(c),
    { method: 'WS', path: new URL(c.req.raw.url).pathname, body: turn.body },
    turn.backgroundScheduler,
    true,
    attempt.timing,
  );
  const gateway = createChatGatewayCtxFromHono(c, {
    wantsStream: true,
    attempt,
    model: turn.payload.model,
    requestBody: takeRequestBody(turn.body),
    downstreamAbortController: turn.downstreamAbortController,
    backgroundScheduler: turn.backgroundScheduler,
    dump,
  }, turn.store);
  const base = prologueFor(gateway, { body: turn.body, headers: turn.headers }, dump);

  return {
    ...base,
    gateway,
    services: {
      ...base.services,
      gateway,
      selectAffinity: candidate => { gateway.affinity.select(candidate); },
      openaiResponsesWebSocketTurn: turn.turn,
    },
  };
};

const handleClientMessage = async (
  c: AuthedContext,
  socket: OpenAIResponsesWebSocketSocket,
  session: ReturnType<typeof createOpenAIResponsesWsSession>,
  data: unknown,
  authenticatedRawKey: string,
  downstreamAbortController: AbortController,
  turn: OpenAIResponsesWebSocketTurn,
  isClosed: () => boolean,
  backgroundScheduler: BackgroundScheduler,
): Promise<void> => {
  const signal = downstreamAbortController.signal;
  const cancelled = (): boolean => (signal.aborted && turn.interruption === undefined) || isClosed();
  let eventId: string | undefined;
  let ctx: ChatGatewayCtx | undefined;
  let previousResponseId: string | undefined;

  // "If a continuation turn fails with a `4xx` or `5xx` error, the server MUST evict the
  // referenced `previous_response_id` from the connection-local cache. A later attempt to
  // continue from that evicted `store=false` response ID on the same connection MUST fail
  // with `previous_response_not_found`."
  // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L127
  //
  // Eviction is wired at two points because a failing turn can leave through two exits that
  // do not share a path. `fail` covers the turn that answers the client with an error
  // envelope, including the refusals the chain hands back as a body rather than a stream; the
  // streaming loop's `finally` covers the turn that ends failed without one. A throw inside
  // the loop is the single path that takes both, and `Map.delete` makes the second call inert.
  const turnFailure: OpenAIResponsesWsTurnFailure = {
    evict: () => {
      if (ctx === undefined || previousResponseId === undefined) return;
      session.evictSnapshot(ctx.store.apiKeyId, previousResponseId);
    },
    fail: (status, error) => {
      turnFailure.evict();
      sendError(socket, status, error, eventId, ctx?.dump);
    },
  };

  try {
    // Capture raw frame bytes up front so they're available as the run's request body when
    // the turn is opened below. Payloads that fail to parse never reach that point, so no
    // dump record is emitted for them — there is no api-key-scoped turn to attribute them to.
    const requestBody: RequestBody = { bytes: wsDataToBytes(data), streamError: null };
    if (!(await authenticateApiKey(c, authenticatedRawKey))) {
      turnFailure.fail(401, {
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
      turnFailure.fail(400, {
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
    if (!('input' in payload)) {
      turnFailure.fail(400, { type: 'invalid_request_error', code: payload.error.code ?? 'invalid_request_error', message: payload.error.message, param: payload.error.param });
      return;
    }
    previousResponseId = payload.previous_response_id ?? undefined;

    const prologue = openOpenAIResponsesWebSocketTurn(c, {
      payload,
      body: requestBody,
      // The upgrade's own headers are the connection's, and every turn on it is dialled with
      // them: this transport has no per-turn header surface, so what a client wants a later
      // turn to carry it carries in the frame body instead.
      headers: [...c.req.raw.headers],
      downstreamAbortController,
      turn,
      backgroundScheduler,
      store: (apiKey, requestStartedAt) => session.createStore(apiKey, requestStartedAt, payload.store ?? undefined),
    });
    ctx = prologue.gateway;

    const { facts, drain } = await run(
      openaiResponsesWebSocketPipeline(),
      move({
        'ingress.http.headers': prologue.headers,
        'ingress.chat.sourceProtocol': 'openaiResponses',
        // A turn on this transport always streams, whatever the client wrote.
        'ingress.chat.openaiResponses.wantsStream': true,
        'ingress.chat.openaiResponses.eventId': eventId,
        'request.chat.openaiResponses': payload,
        'serve.model': payload.model,
      }) as never,
      prologue.services as never,
    );
    prologue.runDump?.afterRun(drain);

    await respondOpenAIResponsesWebSocket({ socket, cancelled, prologue, facts, drain, turnFailure });
  } catch (error) {
    if (cancelled()) return;
    if (error instanceof WebSocketClientMessageError) {
      turnFailure.fail(400, {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: error.message,
      });
      return;
    }
    turnFailure.fail(500, openaiResponsesWebSocketInternalError(error));
    if (ctx !== undefined) {
      ctx.dump?.failed(error);
      ctx.dump?.finalize(500, 0);
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

const validateClientMessage = (parsed: unknown): OpenAIResponsesWebSocketClientEvent => {
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
    throw new WebSocketClientMessageError('WebSocket message must be a JSON object with a string type.');
  }
  return parsed as OpenAIResponsesWebSocketClientEvent;
};

const respondOpenAIResponsesWebSocket = async (input: {
  readonly socket: OpenAIResponsesWebSocketSocket;
  readonly cancelled: () => boolean;
  readonly prologue: ChatPrologue;
  readonly facts: OpenAIResponsesWebSocketExit;
  readonly drain: () => Promise<void>;
  readonly turnFailure: OpenAIResponsesWsTurnFailure;
}): Promise<void> => {
  const { socket, cancelled, prologue, facts, drain, turnFailure } = input;
  const ctx = prologue.gateway;
  const state = new SourceStreamState();
  let completion: StreamCompletion = 'error';
  try {
    for await (const packet of facts['response.chat.openaiResponses.websocket']) {
      if (cancelled() || !sendText(socket, packet.text, ctx.dump)) { completion = 'cancel'; return; }
      if (packet.frame?.type !== 'event') continue;
      const event = packet.frame.event;
      if (event.type === 'error' || event.type === 'response.failed') state.failed = true;
      if (isOpenAIResponsesTerminalEvent(event as unknown as ClientOpenAIResponsesStreamEvent) && !state.failed) state.completed = true;
    }
    completion = 'eof';
  } finally {
    await drain();
    const failed = state.failedAfter(completion);
    if (failed) {
      // `fail` cannot carry the eviction for every failed turn: one that streamed an `error`
      // notification or `response.failed` answered the client with an event rather than an
      // error envelope, and one the client abandoned before the terminal event answered with
      // nothing at all. Both settle here. For the abandoned turn the eviction is inert — the
      // connection-local cache dies with the socket.
      turnFailure.evict();
      ctx.dump?.failed(`openai-responses ws turn failed (completion=${completion}, source-failed=${state.failed})`, { fallback: true });
    }
    ctx.dump?.finalize(failed ? 500 : facts['response.http.status'], 0);
  }
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
  dump?: RunDump | null,
): void => {
  sendJson(socket, { type: 'error', status, error }, eventId, dump);
};

const sendJson = (
  socket: OpenAIResponsesWebSocketSocket,
  value: unknown,
  eventId?: string,
  dump?: RunDump | null,
): boolean => {
  if (socket.readyState !== 1) return false;
  const payload = eventId === undefined || !value || typeof value !== 'object'
    ? value
    : { ...value, event_id: eventId };
  return sendText(socket, JSON.stringify(payload), dump);
};

const sendText = (socket: OpenAIResponsesWebSocketSocket, text: string, dump?: RunDump | null): boolean => {
  if (socket.readyState !== 1) return false;
  try { socket.send(text); } catch { return false; }
  dump?.recordSentPayloadBytes(UTF8_ENCODER.encode(text).byteLength);
  return true;
};
