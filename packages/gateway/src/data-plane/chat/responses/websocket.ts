import type { Context } from 'hono';

import { wrapResponsesClientEgress } from './client-output.ts';
import { createResponsesWsSession } from './items/store.ts';
import { PreviousResponseNotFoundError } from './serve-prep.ts';
import { responsesServe } from './serve.ts';
import type { DumpAccumulator } from '../../../dump/accumulator.ts';
import { apiKeyFromContext, authenticateApiKey, type AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { inboundHeaders } from '../../shared/inbound-headers.ts';
import { takeRequestBody } from '../../shared/request-body.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS, type StreamCompletion } from '../../shared/sse.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import { createChatGatewayCtxFromHono, type ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { SourceStreamState, eventResultMetadata } from '../shared/respond.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { RESPONSES_MISSING_TERMINAL_MESSAGE } from '@floway-dev/protocols/responses';
import { isResponsesTerminalEvent, type CanonicalResponsesPayload, type ClientResponsesStreamEvent, type ResponsesRequestPayload, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult } from '@floway-dev/provider';
import { toInternalDebugError } from '@floway-dev/provider';
import { canonicalizeResponsesPayload, TranslatorInputError } from '@floway-dev/translate';

interface WorkerWebSocket extends WebSocket {
  accept(): void;
}

interface ResponsesWebSocketSocket {
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

// The spec puts the creation body's fields at the top level of
// `response.create`; the nested `response` envelope of Realtime-style clients
// is an extension we also accept, and prefer when present.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L99-L115
type ResponsesWebSocketClientEvent = Partial<ResponsesRequestPayload> & {
  type: string;
  event_id?: string;
  response?: Partial<ResponsesRequestPayload>;
  [key: string]: unknown;
};

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
        // an open socket, so we serialize the error inline as the spec's
        // WebSocket error envelope. (HTTP entries let onError handle the same case.)
        .catch(error => {
          if (!closed) sendError(socket, 500, serverErrorEnvelope(error));
        });
    },
  };
};

interface ResponsesWsTurnFailure {
  evict(): void;
  fail(status: number, error: Record<string, unknown>): void;
}

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
  let previousResponseId: string | undefined;

  // "If a continuation turn fails with a `4xx` or `5xx` error, the server MUST
  // evict the referenced `previous_response_id` from the connection-local
  // cache. A later attempt to continue from that evicted `store=false`
  // response ID on the same connection MUST fail with
  // `previous_response_not_found`."
  // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L127
  //
  // Eviction is wired at two points because a failing turn can leave through
  // two exits that do not share a path. `fail` covers the turn that answers
  // the client with an error envelope, including the `api-error` and
  // `internal-error` results, which return before the streaming loop is
  // entered; the loop's `finally` covers the turn that ends failed without
  // one. A throw inside the loop is the single path that takes both, and
  // `Map.delete` makes the second call inert.
  const turnFailure: ResponsesWsTurnFailure = {
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
    // Capture raw frame bytes up front so they're available as the dump's
    // request body when `ctx` is constructed below. Payloads that fail to
    // parse never reach ctx construction, so no dump record is emitted for
    // them — there is no api-key-scoped turn to attribute them to.
    const requestBody = { bytes: wsDataToBytes(data), streamError: null };
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
    const payload = responsesPayloadFromClientSource(source);
    previousResponseId = payload.previous_response_id ?? undefined;
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
    }, (apiKey, requestStartedAt) => session.createStore(apiKey, requestStartedAt, payload.store ?? undefined));

    let result;
    try {
      result = await responsesServe.generate({ payload, ctx, headers: inboundHeaders(c) });
    } catch (error) {
      if (signal.aborted || isClosed()) return;
      // The HTTP entry renders this verbatim envelope as a 400; WS surfaces the
      // same body nested under the spec's WebSocket error envelope so clients
      // can still compare error.message byte-for-byte against upstream.
      if (error instanceof PreviousResponseNotFoundError) {
        turnFailure.fail(400, {
          message: error.message,
          type: 'invalid_request_error',
          param: 'previous_response_id',
          code: 'previous_response_not_found',
        });
        ctx.dump?.failed(error);
        ctx.dump?.finalize(400, []);
        return;
      }
      throw error;
    }

    await respondResponsesWebSocket({ socket, eventId, signal, isClosed, result, ctx, payload, turnFailure });
  } catch (error) {
    if (signal.aborted || isClosed()) return;
    if (error instanceof TranslatorInputError) {
      turnFailure.fail(400, {
        type: 'invalid_request_error',
        code: error.code ?? 'invalid_request_error',
        message: error.message,
        param: error.param,
      });
      return;
    }
    if (error instanceof WebSocketClientMessageError) {
      turnFailure.fail(400, {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: error.message,
      });
      return;
    }
    turnFailure.fail(500, serverErrorEnvelope(error));
    if (ctx !== undefined) {
      // Mid-attempt throws (interceptor bug, translation error, provider-layer JS
      // exception not represented as a ChatServeFailure) never reach the
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

// The transport always streams, whatever the client sent.
const responsesPayloadFromClientSource = (source: object): CanonicalResponsesPayload =>
  ({ ...canonicalizeResponsesPayload(source as ResponsesRequestPayload), stream: true });

const respondResponsesWebSocket = async (input: {
  readonly socket: ResponsesWebSocketSocket;
  readonly eventId: string | undefined;
  readonly signal: AbortSignal;
  readonly isClosed: () => boolean;
  readonly result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>;
  readonly ctx: ChatGatewayCtx;
  readonly payload: CanonicalResponsesPayload;
  readonly turnFailure: ResponsesWsTurnFailure;
}): Promise<void> => {
  const { socket, eventId, signal, isClosed, result, ctx, payload, turnFailure } = input;
  if (result.type === 'api-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.error(result.source, result.upstreamId);
    turnFailure.fail(result.status, normalizeErrorBody(parseMaybeJson(result.body, result.headers), result.status));
    ctx.dump?.finalize(result.status, []);
    return;
  }

  if (result.type === 'internal-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.failed(result.error.message);
    turnFailure.fail(result.status, internalErrorEnvelope(result.error));
    ctx.dump?.finalize(result.status, []);
    return;
  }

  const state = new SourceStreamState();
  let completion: StreamCompletion = 'error';
  try {
    let terminalEvent: ClientResponsesStreamEvent | undefined;
    const observed = observeResponsesWebSocketFrames(result.events, state, ctx);
    const output = wrapResponsesClientEgress(observed, ctx, payload);
    const iterator = output[Symbol.asyncIterator]();
    let pendingNext = pendingWsFrameResult(iterator.next());
    let completed = false;
    let stoppedByDownstream = false;
    let streamed = false;
    const sequence = createDownstreamSequence();

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
          // Extended reasoning turns go completely silent: upstream sends SSE
          // `ping` events, `parseResponsesStream` drops them, and no frame at
          // all reaches this socket for minutes. A silent Workers WebSocket
          // does not reliably survive that. Cloudflare states the
          // teardown without naming a duration — "when no data is transmitted
          // in either direction for a period of time" — and probing a
          // `workers.dev` endpoint built on this handler's own `WebSocketPair`
          // shape found no constant to design against: from one vantage point
          // an idle socket lived a full hour, 4/4, while from another 13 of 16
          // idle sockets died between 215.8 s and 1788.2 s, median around
          // 660 s. Teardown is path-dependent and stochastic, and it is always
          // a silent EOF — across roughly 40 observed teardowns, not one CLOSE
          // frame and not one RST, so the failure carries no protocol-level
          // signal.
          // https://developers.cloudflare.com/network/websockets/#idle-timeout
          //
          // Cloudflare's stated remedy, a client-side ping/pong heartbeat,
          // does not cover it: on the path that drops, 6 of 9 sockets pinging
          // every 30 s died anyway, one of them after 61.5 s. A
          // server-originated text frame did cover it — 12/12 survived on that
          // same path, with ≤400 s intervals holding and ≥500 s failing. Why a
          // data frame outlives a protocol ping there was not established.
          // Sending a ping is not open to us regardless: workerd's `WebSocket`
          // exposes only accept/send/close/(de)serializeAttachment, and the kj
          // layer beneath states the omission as a design decision ("Ping/Pong
          // … are not exposed through this interface"). RFC 6455 §5.5.2 is the
          // right mechanism, it is unreachable here, and it would not help the
          // client that needs it most either, since Codex's frame pump
          // swallows control frames and only a text frame rearms its 300 s
          // idle timeout.
          // https://github.com/cloudflare/workerd/blob/26b5461b7dcc640bb16072f1ba6f2c6df82572ba/src/workerd/api/web-socket.h#L346-L394
          // https://github.com/capnproto/capnproto/blob/e9fa5c7dc98192fc0dc0098ec770db68f997a938/c%2B%2B/src/kj/compat/http.h#L622-L631
          // https://github.com/openai/codex/blob/e6cfd40c3f444aadd6017c9eeab01db70f48961a/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L91-L101
          // https://github.com/openai/codex/blob/e6cfd40c3f444aadd6017c9eeab01db70f48961a/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L695-L699
          // https://github.com/openai/codex/blob/e6cfd40c3f444aadd6017c9eeab01db70f48961a/codex-rs/model-provider-info/src/lib.rs#L26
          //
          // So the keep-alive is a text frame whose `type` no client
          // recognizes. The spec's extension section governs its shape: an
          // implementor slug prefix plus a `sequence_number`. A keep-alive is
          // neither a delta nor a state-machine event, so it cannot be spelled
          // as a `response.*` event; the slug form is what makes it ignorable
          // without loss. openai-node's SSE `responses.stream()` helper is the
          // one client that treats a prefixed type as fatal — its accumulator
          // closes its `switch` on `assertNever` — and it is out of reach here:
          // Floway's SSE keep-alive is a comment line, and this frame exists
          // only on the WebSocket transport.
          // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L758
          // https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/lib/responses/ResponseAccumulator.ts#L387-L389
          //
          // Held back until the turn's first event has gone out. That gate is
          // parity with the stricter transport, not a demand of this one: both
          // SDKs' SSE stream helpers refuse anything before `response.created`
          // — openai-node rejects even its own `keepalive` type there — while
          // every WebSocket reader we can inspect tolerates an unknown type at
          // any position, openai-node emitting it under a name nothing listens
          // on, openai-python constructing it unchecked, and Codex tracing and
          // discarding it. The window before the first event therefore stays
          // unprotected, and closing it is a behavior question rather than a
          // client-compatibility one.
          // https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/lib/responses/ResponseAccumulator.ts#L25-L31
          // https://github.com/openai/openai-python/blob/3844843c277f42b0b18beaa58152cfda61df524a/src/openai/lib/streaming/responses/_responses.py#L369-L370
          // https://github.com/openai/openai-python/blob/3844843c277f42b0b18beaa58152cfda61df524a/src/openai/resources/responses/responses.py#L4493-L4502
          // https://github.com/openai/codex/blob/e6cfd40c3f444aadd6017c9eeab01db70f48961a/codex-rs/codex-api/src/sse/responses.rs#L466-L472
          if (!streamed) continue;
          if (!sendJson(socket, { type: KEEP_ALIVE_EVENT_TYPE, sequence_number: sequence.take() }, eventId, ctx.dump)) {
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
        if (frame.type !== 'event') continue;

        const event = frame.event;

        // The wrapped terminal event arrives only after its item and snapshot
        // writes have committed, but the generator still has work to drain
        // behind it. Buffer it here and flush it once the loop has run to
        // completion, so the terminal event is the last frame of the turn and
        // is itself the signal that a follow-up turn may reference this
        // response. WebSocket carries the same streaming event objects as
        // streaming HTTP, and the specification defines no frame after the
        // terminal event:
        // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L117
        // Live captures agree. Azure Foundry Responses-over-WebSocket, and the
        // ChatGPT backend the Codex CLI talks to, both end a turn on
        // `response.completed` and send nothing further while the socket stays
        // open and idle. Codex's own reader breaks its loop on that event
        // rather than waiting for any trailing envelope:
        // https://github.com/openai/codex/blob/acd540f1581bf30f963fccbcce43ac494102242c/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L792-L799
        if (terminalEvent !== undefined) continue;

        if (isResponsesTerminalEvent(event)) {
          terminalEvent = event;
          continue;
        }

        if (!sendResponsesEvent(socket, sequence.renumber(event), eventId, ctx.dump)) {
          stopForDownstream();
          return;
        }
        streamed = true;
      }
    } finally {
      if (!completed) {
        const stopped = iterator.return?.(undefined);
        if (stoppedByDownstream) stopped?.catch(() => {});
        else await stopped;
      }
    }

    if (terminalEvent === undefined) {
      throw new Error(RESPONSES_MISSING_TERMINAL_MESSAGE);
    }
    // Renumbered here rather than where it was buffered: keep-alives can still
    // fire while the generator drains behind the terminal event, and each of
    // those takes a slot that has to land before the terminal event's own.
    if (!sendResponsesEvent(socket, sequence.renumber(terminalEvent), eventId, ctx.dump)) {
      completion = 'cancel';
      return;
    }
    completion = 'eof';
  } catch (error) {
    if (signal.aborted || isClosed()) {
      completion = 'cancel';
      return;
    }
    state.failed = true;
    turnFailure.fail(500, serverErrorEnvelope(error));
  } finally {
    const metadata = await eventResultMetadata(result);
    const failed = state.failedAfter(completion);
    if (failed) {
      // `fail` cannot carry the eviction for every failed turn: one that
      // streamed an `error` or `response.failed` terminal answered the client
      // with an event rather than an error envelope, and one the client
      // abandoned before the terminal event answered with nothing at all.
      // Both settle here. For the abandoned turn the eviction is inert — the
      // connection-local cache dies with the socket.
      turnFailure.evict();
      ctx.dump?.failed(`responses ws turn failed (completion=${completion}, source-failed=${state.failed})`);
    } else ctx.dump?.success(metadata.modelIdentity, tokenUsageFromBillableUsage(metadata.billableUsage));
    ctx.dump?.finalize(failed ? 500 : 200, []);
    settle(ctx, metadata.performance, metadata.modelIdentity, tokenUsageFromBillableUsage(metadata.billableUsage), failed);
  }
};

const observeResponsesWebSocketFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  state: SourceStreamState,
  ctx: ChatGatewayCtx,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  for await (const frame of frames) {
    ctx.dump?.frame(frame);
    if (frame.type === 'event') {
      const event = frame.event;
      const failed = event.type === 'error' || event.type === 'response.failed';
      if (failed) state.failed = true;
      if (isResponsesTerminalEvent(event) && !failed) state.completed = true;
    }
    yield frame;
  }
};

type WsFrameRaceResult =
  | { type: 'frame'; result: IteratorResult<ProtocolFrame<ClientResponsesStreamEvent>> }
  | { type: 'next-error'; error: unknown }
  | { type: 'keep-alive' };

const pendingWsFrameResult = (pendingNext: Promise<IteratorResult<ProtocolFrame<ClientResponsesStreamEvent>>>): Promise<WsFrameRaceResult> =>
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
  renumber(event: ClientResponsesStreamEvent): ClientResponsesStreamEvent;
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

const normalizeErrorBody = (body: unknown, status: number): Record<string, unknown> => {
  const source = body && typeof body === 'object' && 'error' in body && typeof (body as { error?: unknown }).error === 'object'
    ? (body as { error: Record<string, unknown> }).error
    : body && typeof body === 'object'
      ? body as Record<string, unknown>
      : {};
  const type = typeof source.type === 'string'
    ? source.type
    : status >= 500 ? 'server_error' : 'invalid_request_error';
  const message = typeof source.message === 'string'
    ? source.message
    : `Responses request failed with status ${status}.`;
  return {
    ...source,
    type,
    code: typeof source.code === 'string' ? source.code : type,
    message,
  };
};

// "WebSocket failures MUST be sent as a JSON `error` envelope with a `status`
// code and an `error.code`."
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L166
// The `WebSocketErrorEvent` schema requires `type`, `status`, and `error` and
// leaves the top level open, so `sendJson` may add `event_id` beside them.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/schema/components/schemas/WebSocketErrorEvent.json#L47
const sendError = (
  socket: ResponsesWebSocketSocket,
  status: number,
  error: Record<string, unknown>,
  eventId?: string,
  dump?: DumpAccumulator | null,
): void => {
  sendJson(socket, { type: 'error', status, error }, eventId, dump);
};

// A turn's own frames go out through this entry, which accepts only a stream
// event whose response resource has already passed the client-facing egress
// stage. The two frames Floway synthesizes for the transport itself — the
// `error` envelope and the `floway:keep_alive` keep-alive — carry no response
// resource at all, and neither belongs to the stream-event union: the error
// envelope is not a streaming event, and the keep-alive is a slug-prefixed
// extension the union deliberately does not model. Both keep the untyped
// `sendJson`.
const sendResponsesEvent = (
  socket: ResponsesWebSocketSocket,
  event: ClientResponsesStreamEvent,
  eventId?: string,
  dump?: DumpAccumulator | null,
): boolean => sendJson(socket, event, eventId, dump);

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
