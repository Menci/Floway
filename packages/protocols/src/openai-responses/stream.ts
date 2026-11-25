import { isOpenAIResponsesTerminalEvent, type OpenAIResponsesResultEx, openaiResponsesResultToEvents, type OpenAIResponsesStreamEventEx } from './index.ts';
import { decodeSseEvents, protocolDecodeError, type ProtocolByteStream, type ProtocolEventStream } from '../common/decode-sse-events.ts';
import { isJsonObject, type JsonObject } from '../common/json.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '../common/sse.ts';

export interface ParseOpenAIResponsesStreamOptions {
  signal?: AbortSignal | undefined;
}

// Lifecycle wrappers, resource terminals, and error notifications carry no
// content deltas. Unknown event types count as structured content so a new
// content event cannot accidentally trigger duplicate fast-path expansion.
const isStructuredOpenAIResponsesEvent = (event: { type: string }): boolean =>
  event.type !== 'response.queued'
  && event.type !== 'response.created'
  && event.type !== 'response.in_progress'
  && event.type !== 'error'
  && !isOpenAIResponsesTerminalEvent(event as OpenAIResponsesStreamEventEx);

// Some OpenAI Responses upstreams emit the event type only via the SSE `event:`
// header and leave it off the JSON body; re-attach it so downstream sees a
// consistent shape.
const projectSseJsonEvent = (event: OpenAIResponsesStreamEventEx, eventName: string | undefined): OpenAIResponsesStreamEventEx =>
  eventName && !(event as { type?: string }).type ? ({ ...event, type: eventName } as OpenAIResponsesStreamEventEx) : event;

// Per OpenAI Responses spec every stream event carries a monotonic
// `sequence_number`, but probes / fast-path completions on Copilot omit it
// on the wire. This parser fills in the missing values with a per-stream
// counter so downstream consumers can always rely on the field being present
// and increasing. When upstream does provide a number we adopt it and advance
// the counter past it, so synthesized fill-ins continue the same sequence
// without colliding.
const sequencer = () => {
  let next = 0;
  const stampNext = (event: OpenAIResponsesStreamEventEx): OpenAIResponsesStreamEventEx => ({ ...event, sequence_number: next++ });
  return {
    stampNext,
    stamp(event: OpenAIResponsesStreamEventEx): OpenAIResponsesStreamEventEx {
      if (event.sequence_number === undefined) return stampNext(event);
      if (event.sequence_number >= next) next = event.sequence_number + 1;
      return event;
    },
  };
};

// Some OpenAI Responses upstreams (notably Copilot for short prompts) take a
// "fast-path": they only emit `response.created` / `response.in_progress` and
// a terminal `response.completed` / `response.incomplete` / `response.failed`,
// skipping every content-bearing structured event. This parser expands the
// terminal in place via `openaiResponsesResultToEvents` so downstream consumers
// always observe one canonical full event sequence. Error notifications pass
// through before the terminal response and do not suppress its expansion.
const normalizeEvents = () => {
  let sawStructured = false;
  const sentWrapperTypes = new Set<OpenAIResponsesStreamEventEx['type']>();
  const { stamp, stampNext } = sequencer();
  return function* (data: OpenAIResponsesStreamEventEx, eventName: string | undefined) {
    // A keep-alive `ping` is neither a delta event nor a state-machine event,
    // so the OpenAI Responses event union admits no such member. Drop it off the raw
    // body, before the body is projected into a typed event, so the union
    // never has to name it; an upstream carries the name either in the JSON
    // body or only in the SSE `event:` header.
    // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L459
    if (((data as { type?: string }).type ?? eventName) === 'ping') return;

    const event = projectSseJsonEvent(data, eventName);
    const structured = isStructuredOpenAIResponsesEvent(event);
    const terminal = isOpenAIResponsesTerminalEvent(event);

    if (!sawStructured && terminal && !structured && 'response' in event) {
      // Fast-path: terminal arrived before any content-bearing structured
      // event. If wrappers were already sent downstream, keep them and
      // synthesize only the missing item/content events plus terminal.
      // `openaiResponsesResultToEvents` numbers from 0; re-stamp each frame
      // through the per-stream sequencer so they continue the same sequence.
      for (const expanded of openaiResponsesResultToEvents((event as { response: OpenAIResponsesResultEx }).response)) {
        if (sentWrapperTypes.has(expanded.event.type)) continue;
        yield stampNext(expanded.event);
      }
      sawStructured = true;
      return;
    }

    if (!sawStructured && structured) {
      sawStructured = true;
    }

    if (!sawStructured && (event.type === 'response.queued' || event.type === 'response.created' || event.type === 'response.in_progress')) sentWrapperTypes.add(event.type);
    yield stamp(event);
  };
};

const isExpandableOutputItem = (item: unknown): boolean => {
  if (!isJsonObject(item) || typeof item.type !== 'string') return false;
  switch (item.type) {
  case 'message':
    return typeof item.id === 'string' && Array.isArray(item.content) && item.content.every(part =>
      isJsonObject(part) && (part.type === 'output_text' ? typeof part.text === 'string' : typeof part.refusal === 'string'));
  case 'reasoning':
    return typeof item.id === 'string' && Array.isArray(item.summary) && item.summary.every(part =>
      isJsonObject(part) && typeof part.text === 'string');
  case 'function_call':
    return typeof item.id === 'string' && typeof item.arguments === 'string';
  case 'custom_tool_call':
    return typeof item.id === 'string' && typeof item.input === 'string';
  case 'web_search_call':
  case 'image_generation_call':
    return typeof item.id === 'string';
  default:
    return true;
  }
};

export type OpenAIResponsesSseFailureEvent =
  | { notification: JsonObject; failed?: JsonObject }
  | { notification?: JsonObject; failed: JsonObject };

const responsesSseFailure = (event: OpenAIResponsesSseFailureEvent, cause?: unknown) => {
  const resource = event.failed?.response;
  const failedError = isJsonObject(resource) && isJsonObject(resource.error) ? resource.error : undefined;
  const notificationError = isJsonObject(event.notification?.error) ? event.notification.error : event.notification;
  const message = failedError?.message ?? notificationError?.message;
  return protocolDecodeError(`Upstream OpenAI Responses SSE error${typeof message === 'string' ? `: ${message}` : ''}`, cause, event);
};

export const decodeOpenAIResponsesStream = async function* <Failure>(
  body: ProtocolByteStream<Failure>,
): ProtocolEventStream<OpenAIResponsesStreamEventEx, Failure> {
  const normalize = normalizeEvents();
  let ended = false;
  let notification: JsonObject | undefined;
  for await (const item of decodeSseEvents<OpenAIResponsesStreamEventEx, Failure>(body, {
    protocol: 'OpenAI Responses', malformedJsonEventName: 'response', ignoreEvents: () => ended,
  })) {
    if (!item.ok) {
      yield notification === undefined ? item : responsesSseFailure({ notification }, item.error);
      return;
    }
    const { data, eventName } = item.value;
    const wire: JsonObject = data;
    const type = typeof wire.type === 'string'
      ? wire.type
      : wire.type === undefined ? eventName ?? (isJsonObject(wire.error) ? 'error' : undefined) : undefined;
    if (type === undefined) {
      yield notification === undefined
        ? protocolDecodeError('Expected an OpenAI Responses SSE event type', data)
        : responsesSseFailure({ notification }, data);
      return;
    }
    if (type === 'error') {
      notification ??= wire.type === undefined ? { ...wire, type } : wire;
      continue;
    }
    const projected = projectSseJsonEvent(data, type);
    if (isOpenAIResponsesTerminalEvent(projected)) {
      const { response } = projected as { response?: unknown };
      if (!isJsonObject(response) || !Array.isArray(response.output) || !response.output.every(isExpandableOutputItem)
        || (response.status !== 'completed' && response.status !== 'incomplete' && response.status !== 'failed')) {
        yield notification === undefined
          ? protocolDecodeError('Invalid terminal response resource in OpenAI Responses SSE', projected)
          : responsesSseFailure({ notification }, projected);
        return;
      }
      // The native protocol treats every failed resource as a failure. Translation owns the content-filter projection.
      // https://github.com/Menci/Floway/blob/844908d7813c92b59e836e5b4cec772a156e53c4/packages/gateway/src/data-plane/chat/openai-responses/respond.ts#L190-L191
      if (type === 'response.failed') {
        const failed = wire.type === undefined ? { ...wire, type } : wire;
        yield responsesSseFailure(notification === undefined ? { failed } : { notification, failed });
        return;
      }
      if (notification !== undefined) {
        yield responsesSseFailure({ notification });
        return;
      }
    }
    if (notification !== undefined) continue;
    for (const event of normalize(data, eventName)) {
      ended ||= isOpenAIResponsesTerminalEvent(event);
      yield { ok: true, value: event };
    }
  }
  if (notification !== undefined) yield responsesSseFailure({ notification });
  else if (!ended) yield protocolDecodeError('OpenAI Responses stream ended without a terminal response event');
};

export const parseOpenAIResponsesStream = async function* (
  body: ReadableStream<Uint8Array>,
  options: ParseOpenAIResponsesStreamOptions = {},
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  const normalize = normalizeEvents();
  for await (const frame of parseTargetStreamFrames<OpenAIResponsesStreamEventEx>(parseSSEStream(body, options), {
    protocol: 'OpenAI Responses',
    malformedJsonEventName: 'response',
  })) {
    if (frame.type === 'done') {
      yield doneFrame();
      return;
    }
    const eventName = frame.frame.type === 'sse' ? frame.frame.event : undefined;
    for (const event of normalize(frame.data, eventName)) yield eventFrame(event);
  }
};
