import type { Context } from 'hono';

import { wrapNativeResponsesClientOutput } from './client-output.ts';
import { createResponsesWsSession } from './items/store.ts';
import { PreviousResponseNotFoundError } from './serve-prep.ts';
import { responsesServe } from './serve.ts';
import type { DumpAccumulator } from '../../../dump/accumulator.ts';
import { apiKeyFromContext, authenticateApiKey, type AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { inboundHeadersForUpstream } from '../../shared/inbound-headers.ts';
import { takeRequestBody } from '../../shared/request-body.ts';
import type { StreamCompletion } from '../../shared/sse.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import { createChatGatewayCtxFromHono, type ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { SourceStreamState, eventResultMetadata } from '../shared/respond.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { RESPONSES_MISSING_TERMINAL_MESSAGE } from '@floway-dev/protocols/responses';
import { isResponsesTerminalEvent, type CanonicalResponsesPayload, type ResponsesRequestPayload, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
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
        // an open socket, so we serialize the error inline as the spec's
        // WebSocket error envelope. (HTTP entries let onError handle the same case.)
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
    }, (apiKey, requestStartedAt) => session.createStore(apiKey, requestStartedAt, payload.store ?? undefined));

    let result;
    try {
      result = await responsesServe.generate({ payload, ctx, headers: inboundHeadersForUpstream(c) });
    } catch (error) {
      if (signal.aborted || isClosed()) return;
      // The HTTP entry renders this verbatim envelope as a 400; WS surfaces the
      // same body nested under the spec's WebSocket error envelope so clients
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
  readonly ctx: ChatGatewayCtx;
}): Promise<void> => {
  const { socket, eventId, signal, isClosed, result, ctx } = input;
  if (result.type === 'api-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.error(result.source, result.upstreamId);
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
    const observed = observeResponsesWebSocketFrames(result.events, state, ctx);
    const output = wrapNativeResponsesClientOutput(observed, ctx);
    const iterator = output[Symbol.asyncIterator]();
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

        // An idle upstream is simply awaited: while a turn is still reasoning,
        // nothing goes downstream. `ping` is not a member of the Responses
        // streaming-event union, so the JSON keep-alive frame this replaces
        // made any turn with a gap longer than the interval unvalidatable.
        // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L117
        //
        // That keep-alive was not copied from the SSE transport; it was added
        // (7345f2806) for a WebSocket-specific failure. Extended reasoning
        // produces SSE `ping` events upstream, `parseResponsesStream` drops
        // them, and the socket then carries no frames at all — at which point
        // Cloudflare's edge, which closes a WebSocket idle in both directions
        // and documents a client-side heartbeat as the remedy, kills it. A raw
        // probe against a Cloudflare-proxied endpoint was torn down at TCP
        // level at 125 s with no close frame and zero edge-originated pings; a
        // second probe pinging every 30 s survived past 200 s.
        // https://developers.cloudflare.com/network/websockets/
        //
        // The correct mechanism is a ping/pong control frame (RFC 6455 §5.5.2)
        // and it is unreachable from a Worker. workerd's `WebSocket` exposes
        // only accept/send/close/(de)serializeAttachment, and the kj layer
        // beneath states the omission as a design decision: "Ping/Pong … are
        // not exposed through this interface … The implementation is, however,
        // expected to reply to Ping messages it receives."
        // https://github.com/cloudflare/workerd/blob/26b5461b7dcc640bb16072f1ba6f2c6df82572ba/src/workerd/api/web-socket.h#L346-L394
        // https://github.com/capnproto/capnproto/blob/e9fa5c7dc98192fc0dc0098ec770db68f997a938/c%2B%2B/src/kj/compat/http.h#L622-L631
        // https://github.com/cloudflare/workerd/issues/3664
        //
        // So the keep-alive is delegated to the client, per Cloudflare's own
        // guidance: a client protocol ping resets the edge's idle timer because
        // the runtime auto-replies with a pong. What that knowingly gives up:
        // on the Cloudflare target a long silent turn now loses its socket
        // where it previously survived. The Node target is unaffected — nothing
        // between the client and the process enforces an idle timeout.
        const next = await pendingNext;

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
        // response. The spec defines no frame after it: WebSocket carries the
        // same streaming event objects as streaming HTTP.
        // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L117
        if (terminalEvent !== undefined) continue;

        if (isResponsesTerminalEvent(event)) {
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
        const stopped = iterator.return?.(undefined);
        if (stoppedByDownstream) stopped?.catch(() => {});
        else await stopped;
      }
    }

    if (terminalEvent === undefined) {
      throw new Error(RESPONSES_MISSING_TERMINAL_MESSAGE);
    }
    if (!sendJson(socket, terminalEvent, eventId, ctx.dump)) {
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
    sendError(socket, 500, serverErrorEnvelope(error), eventId, ctx.dump);
  } finally {
    const metadata = await eventResultMetadata(result);
    const failed = state.failedAfter(completion);
    if (failed) ctx.dump?.failed(`responses ws turn failed (completion=${completion}, source-failed=${state.failed})`);
    else ctx.dump?.success(metadata.modelIdentity, tokenUsageFromBillableUsage(metadata.billableUsage));
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

type WsFrameResult =
  | { type: 'frame'; result: IteratorResult<ProtocolFrame<ResponsesStreamEvent>> }
  | { type: 'next-error'; error: unknown };

// The next frame is pulled before the current one is sent, so the pending
// promise outlives the statement that created it; folding its rejection into a
// value attaches a handler synchronously and keeps a mid-stream upstream
// failure from surfacing as an unhandled rejection.
const pendingWsFrameResult = (pendingNext: Promise<IteratorResult<ProtocolFrame<ResponsesStreamEvent>>>): Promise<WsFrameResult> =>
  pendingNext.then(
    (result): WsFrameResult => ({ type: 'frame', result }),
    (error): WsFrameResult => ({ type: 'next-error', error }),
  );

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
