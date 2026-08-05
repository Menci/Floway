import { isResponsesTerminalEvent, type ResponsesResult, responsesResultToEvents, type ResponsesStreamEvent } from './index.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '../common/sse.ts';

export interface ParseResponsesStreamOptions {
  signal?: AbortSignal;
}

// Deny-list: anything that is not a wrapper (`response.queued` /
// `response.created` / `response.in_progress`) and not terminal is treated as
// content-bearing. Future Responses event types fall through as structured by
// default, which is safer than missing an allow-list entry and incorrectly
// triggering the fast-path expansion below.
const isStructuredResponsesEvent = (event: { type: string }): boolean =>
  event.type !== 'response.queued'
  && event.type !== 'response.created'
  && event.type !== 'response.in_progress'
  && !isResponsesTerminalEvent(event as ResponsesStreamEvent);

// Some Responses upstreams emit the event type only via the SSE `event:`
// header and leave it off the JSON body; re-attach it so downstream sees a
// consistent shape.
const projectSseJsonEvent = (event: ResponsesStreamEvent, eventName: string | undefined): ResponsesStreamEvent =>
  eventName && !(event as { type?: string }).type ? ({ ...event, type: eventName } as ResponsesStreamEvent) : event;

const responseFromTerminalEvent = (event: ResponsesStreamEvent): ResponsesResult | undefined => {
  if (event.type === 'error') return undefined;
  if (event.type !== 'response.completed' && event.type !== 'response.incomplete' && event.type !== 'response.failed') return undefined;
  const response = (event as { response?: unknown }).response;
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    throw new TypeError(`${event.type} must carry a response object`);
  }
  const expectedStatus = event.type === 'response.completed' ? 'completed'
    : event.type === 'response.incomplete' ? 'incomplete'
      : 'failed';
  if ((response as { status?: unknown }).status !== expectedStatus) {
    throw new TypeError(`${event.type} cannot carry Responses status ${JSON.stringify((response as { status?: unknown }).status)}`);
  }
  return response as ResponsesResult;
};

// Per OpenAI Responses spec every stream event carries a monotonic
// `sequence_number`, but probes / fast-path completions on Copilot omit it
// on the wire. This parser fills in the missing values with a per-stream
// counter so downstream consumers can always rely on the field being present
// and increasing. When upstream does provide a number we adopt it and advance
// the counter past it, so synthesized fill-ins continue the same sequence
// without colliding.
const sequencer = () => {
  let next = 0;
  let previous = -1;
  const validateProvided = (event: ResponsesStreamEvent): number | undefined => {
    if (event.sequence_number !== undefined) {
      if (!Number.isSafeInteger(event.sequence_number) || event.sequence_number < 0) {
        throw new RangeError(`Responses sequence_number must be a non-negative safe integer: ${event.sequence_number}`);
      }
      if (event.sequence_number <= previous) {
        throw new RangeError(`Responses sequence_number must increase monotonically: ${event.sequence_number} follows ${previous}`);
      }
    }
    return event.sequence_number;
  };
  const stamp = (event: ResponsesStreamEvent): ResponsesStreamEvent => {
    const provided = validateProvided(event);
    if (provided !== undefined) {
      previous = provided;
      next = provided + 1;
      return event;
    }
    if (!Number.isSafeInteger(next)) throw new RangeError('Responses sequence_number exhausted the safe integer range');
    const stamped: ResponsesStreamEvent = { ...event, sequence_number: next };
    previous = next;
    next++;
    return stamped;
  };
  return { stamp, validateProvided };
};

// Some Responses upstreams (notably Copilot for short prompts) take a
// "fast-path": they only emit `response.created` / `response.in_progress` and
// a terminal `response.completed` / `response.incomplete` / `response.failed`,
// skipping every content-bearing structured event. This parser expands the
// terminal in place via `responsesResultToEvents` so downstream consumers
// always observe one canonical full event sequence. `error` terminals carry
// no `response` payload, so we cannot expand them; they continue to surface
// as their original frame for downstream handlers.
export const parseResponsesStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseResponsesStreamOptions = {},
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> => (async function* () {
  let sawStructured = false;
  const sentWrapperTypes = new Set<ResponsesStreamEvent['type']>();
  const sequence = sequencer();

  for await (const frame of parseTargetStreamFrames<ResponsesStreamEvent>(parseSSEStream(body, options), {
    protocol: 'Responses',
    malformedJsonEventName: 'response',
  })) {
    if (frame.type === 'done') {
      yield doneFrame();
      return;
    }

    // A keep-alive `ping` is neither a delta event nor a state-machine event,
    // so the Responses event union admits no such member. Drop it off the raw
    // body, before the body is projected into a typed event, so the union
    // never has to name it; an upstream carries the name either in the JSON
    // body or only in the SSE `event:` header.
    // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L459
    if (typeof frame.data !== 'object' || frame.data === null || Array.isArray(frame.data)) {
      throw new TypeError('Upstream Responses SSE event must be a JSON object');
    }
    if (((frame.data as { type?: string }).type ?? frame.frame.event) === 'ping') continue;

    const event = projectSseJsonEvent(frame.data, frame.frame.event);
    if (typeof (event as { type?: unknown }).type !== 'string' || event.type.length === 0) {
      throw new TypeError('Upstream Responses SSE event must state a non-empty string type');
    }
    const structured = isStructuredResponsesEvent(event);
    const terminal = isResponsesTerminalEvent(event);
    const terminalResponse = responseFromTerminalEvent(event);

    if (!sawStructured && terminal && !structured && terminalResponse !== undefined) {
      sequence.validateProvided(event);
      // Fast-path: terminal arrived before any content-bearing structured
      // event. If wrappers were already sent downstream, keep them and
      // synthesize only the missing item/content events plus terminal.
      // `responsesResultToEvents` numbers from 0; re-stamp each frame
      // through the per-stream sequencer so they continue the same sequence.
      for (const expanded of responsesResultToEvents(terminalResponse)) {
        if (sentWrapperTypes.has(expanded.event.type)) continue;
        const restamped = { ...expanded.event, sequence_number: undefined } as ResponsesStreamEvent;
        yield eventFrame(sequence.stamp(restamped));
      }
      sawStructured = true;
      continue;
    }

    if (!sawStructured && structured) {
      sawStructured = true;
    }

    if (!sawStructured && (event.type === 'response.queued' || event.type === 'response.created' || event.type === 'response.in_progress')) sentWrapperTypes.add(event.type);
    yield eventFrame(sequence.stamp(event));
  }
})();
