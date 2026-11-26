import { isJsonObject, type JsonObject } from './json.ts';
import { parseSseFrames } from './parse-sse.ts';
import type { Result } from '@floway-dev/pipeline';

export interface ProtocolDecodeError {
  kind: 'protocol';
  cause: unknown;
  event?: JsonObject;
  eventName?: string;
}

export type ProtocolByteStream<Failure> = AsyncIterable<Result<Uint8Array, Failure>>;
export type ProtocolEventStream<Event, Failure> = AsyncGenerator<Result<Event, Failure | ProtocolDecodeError>, void, unknown>;

export const protocolDecodeError = (message: string, cause?: unknown, event?: JsonObject, eventName?: string): Result<never, ProtocolDecodeError> => ({
  ok: false,
  error: {
    kind: 'protocol', cause: new Error(message, { cause }),
    ...(event === undefined ? {} : { event }), ...(eventName === undefined ? {} : { eventName }),
  },
});

export const protocolSseError = (protocol: string, event: JsonObject, eventName?: string): Result<never, ProtocolDecodeError> => {
  const details = isJsonObject(event.error) ? event.error : event;
  const message = typeof details.message === 'string' ? `: ${details.message}` : '';
  return protocolDecodeError(`Upstream ${protocol} SSE error${message}`, undefined, event, eventName);
};

interface DecodeSseEventsOptions {
  protocol: string;
  malformedJsonEventName?: string;
  onRawFrame?: boolean;
  onDone?: () => void;
  ignoreEvents?: () => boolean;
}

export const decodeSseEvents = async function* <Event, Failure>(
  body: ProtocolByteStream<Failure>,
  { protocol, malformedJsonEventName, onRawFrame, onDone, ignoreEvents }: DecodeSseEventsOptions,
): ProtocolEventStream<{ data: Event & JsonObject; eventName: string | undefined }, Failure> {
  let ended = false;
  for await (const item of parseSseFrames(body)) {
    if (!item.ok) {
      yield item;
      return;
    }
    if (ended || ignoreEvents?.()) continue;
    const frame = item.value;
    if (frame.type === 'sse-raw' && onRawFrame !== true) continue;
    const text = frame.data.trim();
    if (text.length === 0) continue;
    if (text === '[DONE]') {
      ended = true;
      onDone?.();
      continue;
    }
    const eventName = frame.type === 'sse' ? frame.event : undefined;
    const context = eventName ?? malformedJsonEventName;
    const description = context ? `${protocol} SSE event "${context}"` : `${protocol} SSE event`;
    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      yield protocolDecodeError(`Malformed upstream ${description} JSON: ${text}`, error);
      return;
    }
    if (!isJsonObject(data)) {
      yield protocolDecodeError(`Expected a JSON object in upstream ${description}`, data);
      return;
    }
    yield { ok: true, value: { data: data as Event & JsonObject, eventName } };
  }
};

interface OpenAISseCompletion<Event> {
  missing: string;
  done?: true;
  event?: (event: Event) => boolean;
}

export interface OpenAISseWireEvent<Event> {
  data: Event;
  eventName?: string;
}

export const decodeOpenAISseWireEvents = async function* <Event, Failure>(
  body: ProtocolByteStream<Failure>,
  protocol: string,
  completion?: OpenAISseCompletion<Event>,
): ProtocolEventStream<OpenAISseWireEvent<Event>, Failure> {
  let ended = false;
  const onDone = () => { if (completion?.done === true) ended = true; };
  for await (const item of decodeSseEvents<Event, Failure>(body, { protocol, onDone, ignoreEvents: () => ended })) {
    if (!item.ok) {
      yield item;
      return;
    }
    const { data, eventName } = item.value;
    if (eventName === 'error' || data.type === 'error' || isJsonObject(data.error)) {
      yield protocolSseError(protocol, data, eventName);
      return;
    }
    ended = completion?.event?.(data) === true;
    yield { ok: true, value: { data, ...(eventName === undefined ? {} : { eventName }) } };
  }
  if (completion !== undefined && !ended) yield protocolDecodeError(completion.missing);
};

export const decodeOpenAISseEvents = async function* <Event, Failure>(
  body: ProtocolByteStream<Failure>,
  protocol: string,
  completion?: OpenAISseCompletion<Event>,
): ProtocolEventStream<Event, Failure> {
  for await (const item of decodeOpenAISseWireEvents(body, protocol, completion)) {
    yield item.ok ? { ok: true, value: item.value.data } : item;
  }
};
