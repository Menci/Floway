import { syntheticEventsFromCompaction } from './items/output.ts';
import type { ResponsesTurnBack } from './stages/stateful-turn.ts';
import type { HttpDelivery, HttpDeliveryFacts, HttpOutput } from '../../pipeline/edge-http.ts';
import { header } from '../../pipeline/non-chat.ts';
import { failedRender, type RenderFacts, type RenderOutcome } from '../../pipeline/render.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS } from '../../shared/sse.ts';
import { transportErrorForDisplay } from '../shared/encode.ts';
import { isTransportFailure } from '@floway-dev/http';
import { Bytes, defineStage, type ManagedStream, snapshotError, type Scope, type StreamEnd } from '@floway-dev/pipeline';
import { isJsonObject } from '@floway-dev/protocols/common';
import {
  type OpenAIResponsesStreamEventEx,
  isOpenAIResponsesTerminalEvent,
  OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE,
} from '@floway-dev/protocols/openai-responses';
import type { ProviderFrame } from '@floway-dev/provider';
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

export interface WebSocketInterruptAccepted {
  readonly type: 'control';
  readonly interrupt: WebSocketInterrupt;
}

type Frame = ProviderFrame<OpenAIResponsesStreamEventEx> | WebSocketInterruptAccepted;
type WebSocketFrame = ReturnType<typeof webSocketError> | OpenAIResponsesStreamEventEx;
export type WebSocketEncodedTurn = HttpOutput & RenderFacts & HttpDeliveryFacts;

export const encodeWebSocketFrame = (frame: object, eventId: string | undefined) =>
  Bytes.fromUtf8(JSON.stringify(eventId === undefined ? frame : { ...frame, event_id: eventId }));

const decodeApiError = (http: HttpOutput['response.http'], value: unknown) => {
  const source = isJsonObject(value) ? isJsonObject(value.error) ? value.error : value : {};
  const type = typeof source.type === 'string' ? source.type : http.status >= 500 ? 'server_error' : 'invalid_request_error';
  return webSocketError(http.status, {
    ...source,
    type,
    code: typeof source.code === 'string' ? source.code : type,
    message: typeof source.message === 'string' ? source.message : `OpenAI Responses request failed with status ${http.status}.`,
  }, header(http.headers, 'retry-after'));
};

const encodeWebSocketResponse = (
  scope: Pick<Scope, 'clock' | 'createStream' | 'wrapStream' | 'deferred'>,
  http: HttpOutput['response.http'], eventId: string | undefined, outcomeValue: Source['response.openaiResponses'],
): WebSocketEncodedTurn => {
  let outcome: RenderOutcome = { kind: 'completed' };
  const onClose = (end: StreamEnd) => {
    const endedAt = scope.clock();
    const failure = end.how === 'errored' ? end.error : end.how === 'cancelled' && end.reason instanceof WebSocketSendError ? end.reason : undefined;
    render.resolve(end.how === 'errored' || end.how === 'leaked' ? failedRender('source-error', failure)
      : end.how === 'exhausted' ? outcome : { kind: 'cancelled' });
    delivery.resolve(failure === undefined
      ? { kind: end.how === 'exhausted' ? 'completed' : 'client-cancelled', endedAt }
      : { kind: 'write-failed', endedAt, error: snapshotError(failure) });
  };
  const frames = async function* (source: AsyncIterable<Frame>, signal: AbortSignal) {
    let terminal: OpenAIResponsesStreamEventEx | undefined;
    for await (const frame of source) {
      if (terminal !== undefined || frame.type === 'done') continue;
      if (isTransportFailure(frame)) {
        outcome = { kind: 'failed', reason: 'source-error', error: frame.error };
        yield { ...webSocketServerError(transportErrorForDisplay(frame.error)), status: 502 };
        return;
      }
      if (frame.type === 'control') {
        yield frame;
        continue;
      }
      const event = frame.event;
      if (event.type === 'error' || event.type === 'response.failed') outcome = failedRender('protocol-error');
      if (isOpenAIResponsesTerminalEvent(event)) terminal = event;
      else yield event;
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
  if (outcomeValue.kind === 'error') {
    const wire = http.transportError === undefined
      ? decodeApiError(http, outcomeValue.error)
      : { ...webSocketServerError(transportErrorForDisplay(http.transportError)), status: http.status };
    const error = encodeWebSocketFrame(wire, eventId);
    stream = scope.createStream({ label: 'Responses WebSocket error', async *iterate() { yield error; }, onClose });
  } else {
    const events = outcomeValue.kind === 'stream' ? outcomeValue.events : scope.createStream<Frame>({
      label: 'Responses WebSocket scalar result',
      iterate: () => syntheticEventsFromCompaction(outcomeValue.result),
    });
    stream = scope.wrapStream(events, {
      label: 'Responses WebSocket frames',
      transform: (source, scope) => encodeFrames(frames(source, scope.signal), eventId, scope.signal),
      onClose,
    });
  }
  const render = scope.deferred<RenderOutcome>('Responses WebSocket rendering', stream);
  const delivery = scope.deferred<HttpDelivery>('Responses WebSocket delivery', stream);
  return {
    'response.http': { ...http, body: stream },
    'response.render': render.deferred,
    'response.delivery': delivery.deferred,
  };
};

type Source = ResponsesTurnBack<WebSocketInterruptAccepted>;
interface Request { readonly 'request.ws.eventId': string | undefined }

export const encodeWebSocketTurn = defineStage<Request, object, Source, WebSocketEncodedTurn>({
  name: 'encode',
  through: {
    request: { needs: ['request.ws.eventId'], consumes: ['request.ws.eventId'], provides: [] },
    response: {
      needs: ['response.http', 'response.openaiResponses'],
      consumes: ['response.openaiResponses'],
      provides: ['response.http', 'response.render', 'response.delivery'],
    },
  },
  execute: async ({ 'request.ws.eventId': eventId, ...facts }, scope) => {
    const { 'response.openaiResponses': events, ...back } = await scope.next(facts);
    return { ...back, ...encodeWebSocketResponse(scope, back['response.http'], eventId, events) };
  },
});

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

type Read = { readonly kind: 'event'; readonly result: IteratorResult<WebSocketFrame | WebSocketInterruptAccepted> }
  | { readonly kind: 'error'; readonly error: unknown };

const encodeFrames = async function* (
  source: AsyncIterable<WebSocketFrame | WebSocketInterruptAccepted>,
  eventId: string | undefined,
  signal: AbortSignal,
) {
  const events = source[Symbol.asyncIterator]();
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
    while (!signal.aborted) {
      if (ready.length === 0) await wait();
      if (signal.aborted) return;
      const next = ready.shift();
      if (next === undefined) {
        if (streamed) yield encodeWebSocketFrame(sequence.keepAlive(), eventId);
      } else if (next.kind === 'error') {
        throw next.error;
      } else {
        if (next.result.done) return;
        const frame = next.result.value;
        if (frame.type === 'control') {
          const { response_id: responseId, event_id: interruptId } = frame.interrupt;
          yield encodeWebSocketFrame(sequence.interruptAccepted(responseId), interruptId);
        } else {
          streamed = true;
          yield encodeWebSocketFrame(sequence.renumber(frame), eventId);
        }
        readEvent();
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    await events.return?.();
  }
};
