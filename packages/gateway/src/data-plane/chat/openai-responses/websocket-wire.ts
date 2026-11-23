import type { HttpDelivery, HttpDeliveryFacts, HttpOutput } from '../../pipeline/edge-http.ts';
import { header, readHttpBytes } from '../../pipeline/non-chat.ts';
import { failedRender, type RenderFacts, type RenderOutcome } from '../../pipeline/render.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS } from '../../shared/sse.ts';
import { Bytes, type ManagedStream, snapshotError, type StageEnv, type StreamEnd } from '@floway-dev/pipeline';
import { isJsonMediaType, isJsonObject, type ProtocolFrame } from '@floway-dev/protocols/common';
import {
  type ClientOpenAIResponsesStreamEvent,
  isOpenAIResponsesTerminalEvent,
  OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE,
  type OpenAIResponsesStreamEventEx,
} from '@floway-dev/protocols/openai-responses';
import { internalDebugErrorFields, toInternalDebugError } from '@floway-dev/provider';

// Only the prefixed extension type and sequence number are required.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L758-L765
export const KEEP_ALIVE_EVENT_TYPE = 'floway:keep_alive';

// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/schema/components/schemas/WebSocketErrorEvent.json#L47
export const webSocketError = (status: number, error: Record<string, unknown>, retryAfter?: string) => ({
  type: 'error' as const, status, error,
  // Codex reads this hint after the upgrade, when HTTP status is unavailable.
  // https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L756-L768
  headers: retryAfter === undefined ? undefined : { 'retry-after': retryAfter },
});

export const webSocketServerError = (error: unknown) => {
  const debug = toInternalDebugError(error);
  return webSocketError(500, {
    type: debug.type, code: debug.type, message: debug.message, provider_specific_fields: internalDebugErrorFields(debug),
  });
};

export class WebSocketSendError extends Error {}

export interface WebSocketInterrupt {
  readonly type: 'response.interrupt';
  readonly response_id: string;
  readonly mode: 'discard_partial_items';
  readonly event_id: string | undefined;
}

type WebSocketFrame = ReturnType<typeof webSocketError> | ClientOpenAIResponsesStreamEvent;
export type WebSocketEncodedTurn = HttpOutput & RenderFacts & HttpDeliveryFacts;

export const encodeWebSocketFrame = (frame: object, eventId: string | undefined) =>
  Bytes.fromUtf8(JSON.stringify(eventId === undefined ? frame : { ...frame, event_id: eventId }));

const decodeApiError = async (http: HttpOutput['response.http']) => {
  const text = (await readHttpBytes(http.body)).utf8();
  let value: unknown = { message: text };
  if (isJsonMediaType(header(http.headers, 'content-type') ?? null)) {
    try {
      value = JSON.parse(text);
    } catch {
      // Some providers attach a JSON content type to plain-text errors.
    }
  }
  const source = isJsonObject(value) ? isJsonObject(value.error) ? value.error : value : {};
  const type = typeof source.type === 'string' ? source.type : http.status >= 500 ? 'server_error' : 'invalid_request_error';
  return webSocketError(http.status, {
    ...source,
    type,
    code: typeof source.code === 'string' ? source.code : type,
    message: typeof source.message === 'string' ? source.message : `OpenAI Responses request failed with status ${http.status}.`,
  }, header(http.headers, 'retry-after'));
};

interface StreamTurn {
  readonly events: ManagedStream<ProtocolFrame<OpenAIResponsesStreamEventEx>>;
  readonly controls: ManagedStream<WebSocketInterrupt>;
  readonly persist: (
    source: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>, signal: AbortSignal,
  ) => AsyncIterable<ProtocolFrame<ClientOpenAIResponsesStreamEvent>>;
  readonly startInterrupt: () => boolean;
  readonly cancelGeneration: () => void;
}

export const encodeWebSocketTurn = async (
  env: StageEnv, http: HttpOutput['response.http'], eventId: string | undefined, turn?: StreamTurn,
): Promise<WebSocketEncodedTurn> => {
  let outcome: RenderOutcome = { kind: 'completed' };
  const onClose = (end: StreamEnd) => {
    const endedAt = env.clock();
    const failure = end.how === 'errored' ? end.error : end.how === 'cancelled' && end.reason instanceof WebSocketSendError ? end.reason : undefined;
    render.resolve(end.how === 'exhausted' || failure !== undefined ? outcome : { kind: 'cancelled' });
    delivery.resolve(failure === undefined
      ? { kind: end.how === 'exhausted' ? 'completed' : 'client-cancelled', endedAt }
      : { kind: 'write-failed', endedAt, error: snapshotError(failure) });
  };
  const frames = async function* (source: AsyncIterable<ProtocolFrame<ClientOpenAIResponsesStreamEvent>>, signal: AbortSignal) {
    let terminal: ClientOpenAIResponsesStreamEvent | undefined;
    try {
      for await (const frame of source) {
        if (frame.type !== 'event' || terminal !== undefined) continue;
        const event = frame.event;
        if (event.type === 'error' || event.type === 'response.failed') outcome = failedRender('protocol-error');
        if (isOpenAIResponsesTerminalEvent(event)) terminal = event;
        else yield event;
      }
    } catch (error) {
      if (!signal.aborted) {
        outcome = failedRender('source-error', error);
        yield webSocketServerError(error);
      }
      return;
    }
    if (signal.aborted) return;
    // Persistence commits before a terminal is yielded. Drain the
    // generation first so the terminal is the last event on the socket.
    if (terminal !== undefined) yield terminal;
    else if (outcome.kind === 'completed') {
      const error = new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE);
      outcome = failedRender('premature-eof', error);
      yield webSocketServerError(error);
    }
  };
  let stream: ManagedStream<Bytes>;
  if (turn === undefined) {
    const error = encodeWebSocketFrame(await decodeApiError(http), eventId);
    stream = env.createStream({ label: 'Responses WebSocket error', async *iterate() { yield error; }, onClose });
  } else {
    stream = env.wrapStream({ generation: turn.events, controls: turn.controls }, {
      label: 'Responses WebSocket frames',
      transform({ generation, controls }, signal) {
        return encodeFrames(frames(turn.persist(generation, signal), signal), controls, eventId, signal, turn);
      },
      onClose,
    });
  }
  const render = env.deferred<RenderOutcome>('Responses WebSocket rendering', stream);
  const delivery = env.deferred<HttpDelivery>('Responses WebSocket delivery', stream);
  return {
    'response.http': { ...http, body: stream },
    'response.render': render.deferred,
    'response.delivery': delivery.deferred,
  };
};

// Keep-alives and interrupt acknowledgements occupy the same sequence as the
// upstream events. Each number is assigned at send time, in wire order.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L117
const createWebSocketSequence = () => {
  let shift = 0;
  let next = 0;
  const take = () => {
    shift++;
    return next++;
  };
  return {
    keepAlive: () => ({ type: KEEP_ALIVE_EVENT_TYPE, sequence_number: take() }),
    interruptAccepted: (responseId: string) => ({ type: 'response.interrupt.accepted', response_id: responseId, sequence_number: take() }),
    renumber: (frame: WebSocketFrame) => {
      if (!('sequence_number' in frame) || frame.sequence_number === undefined) return frame;
      const sequenceNumber = frame.sequence_number + shift;
      next = sequenceNumber + 1;
      return { ...frame, sequence_number: sequenceNumber };
    },
  };
};

type Read = { readonly kind: 'event'; readonly result: IteratorResult<WebSocketFrame> }
  | { readonly kind: 'control'; readonly result: IteratorResult<WebSocketInterrupt> }
  | { readonly kind: 'error'; readonly error: unknown };

const encodeFrames = async function* (
  source: AsyncIterable<WebSocketFrame>,
  controls: AsyncIterable<WebSocketInterrupt>,
  eventId: string | undefined,
  signal: AbortSignal,
  turn: Pick<StreamTurn, 'startInterrupt' | 'cancelGeneration'>,
) {
  const events = source[Symbol.asyncIterator]();
  const control = controls[Symbol.asyncIterator]();
  const sequence = createWebSocketSequence();
  let streamed = false;
  const ready: Read[] = [];
  let wake: (() => void) | undefined;
  const onAbort = () => wake?.();
  const receive = (read: Read) => {
    ready.push(read);
    wake?.();
  };
  const readEvent = () => {
    void events.next().then(
      result => receive({ kind: 'event', result }),
      (error: unknown) => receive({ kind: 'error', error }),
    );
  };
  const wait = async () => {
    const timer = Promise.withResolvers<void>();
    const timeout = setTimeout(timer.resolve, DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS);
    wake = timer.resolve;
    try {
      await timer.promise;
    } finally {
      wake = undefined;
      clearTimeout(timeout);
    }
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    readEvent();
    void control.next().then(
      result => receive({ kind: 'control', result }),
      (error: unknown) => receive({ kind: 'error', error }),
    );
    while (!signal.aborted) {
      if (ready.length === 0) await wait();
      if (signal.aborted) return;
      const next = ready.shift();
      if (next === undefined) {
        if (streamed) yield encodeWebSocketFrame(sequence.keepAlive(), eventId);
      } else if (next.kind === 'error') {
        throw next.error;
      } else if (next.kind === 'control') {
        if (!next.result.done && turn.startInterrupt()) {
          yield encodeWebSocketFrame(sequence.interruptAccepted(next.result.value.response_id), next.result.value.event_id);
          turn.cancelGeneration();
        }
      } else {
        if (next.result.done) return;
        streamed = true;
        yield encodeWebSocketFrame(sequence.renumber(next.result.value), eventId);
        readEvent();
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    await events.return?.();
  }
};
