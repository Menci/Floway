import { isJsonObject, type JsonObject } from './json.ts';
import { parseTargetStreamFrame, protocolDecodeError, type ParseTargetStreamFramesOptions, type ProtocolDecodeError } from './parse-events.ts';
import { parseSseFrames } from './parse-sse.ts';
import type { Result } from '@floway-dev/pipeline';

export type ProtocolByteStream<Failure> = AsyncIterable<Result<Uint8Array, Failure>>;
export type ProtocolEventStream<Event, Failure> = AsyncGenerator<Result<Event, Failure | ProtocolDecodeError>, void, unknown>;

export const protocolSseError = (protocol: string, event: JsonObject, eventName?: string): Result<never, ProtocolDecodeError> => {
  const details = isJsonObject(event.error) ? event.error : event;
  const message = typeof details.message === 'string' ? `: ${details.message}` : '';
  return protocolDecodeError(`Upstream ${protocol} SSE error${message}`, undefined, event, eventName);
};

interface DecodeSseEventsOptions extends ParseTargetStreamFramesOptions {
  onDone?: () => void;
  ignoreEvents?: () => boolean;
}

export interface OpenAISseWireEvent<Event> {
  data: Event;
  eventName?: string;
}

export const decodeSseEvents = async function* <Event, Failure>(
  body: ProtocolByteStream<Failure>,
  options: DecodeSseEventsOptions,
): ProtocolEventStream<OpenAISseWireEvent<Event & JsonObject>, Failure> {
  let ended = false;
  for await (const item of parseSseFrames(body)) {
    if (!item.ok) {
      yield item;
      return;
    }
    // Keep reading through transport EOF to observe a late read failure.
    if (ended || options.ignoreEvents?.()) continue;
    const parsed = parseTargetStreamFrame(item.value, options);
    if (!parsed.ok) {
      yield parsed;
      return;
    }
    const frame = parsed.value;
    if (frame === null) continue;
    if (frame.type === 'done') {
      ended = true;
      options.onDone?.();
      continue;
    }
    const eventName = frame.type === 'sse-json' ? frame.frame.event : undefined;
    if (!isJsonObject(frame.data)) {
      const name = eventName ?? options.malformedJsonEventName;
      const description = name ? `event "${name}"` : 'event';
      yield protocolDecodeError(`Expected a JSON object in upstream ${options.protocol} SSE ${description}`, frame.data, undefined, eventName);
      return;
    }
    yield { ok: true, value: { data: frame.data as Event & JsonObject, ...(eventName === undefined ? {} : { eventName }) } };
  }
};

interface OpenAISseCompletion<Event> {
  missing: string;
  done?: true;
  event?: (event: Event) => boolean;
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
    yield item;
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

export const decodeOpenAISseWireEventsWithType = async function* <Failure>(
  body: ProtocolByteStream<Failure>,
  protocol: string,
): ProtocolEventStream<OpenAISseWireEvent<JsonObject & { type?: string }>, Failure> {
  for await (const item of decodeOpenAISseWireEvents<JsonObject & { type?: string }, Failure>(body, protocol)) {
    if (!item.ok) {
      yield item;
      return;
    }
    const { data, eventName } = item.value;
    const { type } = data;
    if (type !== undefined && typeof type !== 'string') {
      yield protocolDecodeError(`Expected upstream ${protocol} SSE type to be a string`, type, data, eventName);
      return;
    }
    yield item;
  }
};
