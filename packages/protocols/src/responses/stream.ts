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

// Per OpenAI Responses spec every stream event carries a monotonic
// `sequence_number`, but probes / fast-path completions on Copilot omit it
// on the wire. This parser fills in the missing values with a per-stream
// counter so downstream consumers can always rely on the field being present
// and increasing. When upstream does provide a number we adopt it and advance
// the counter past it, so synthesized fill-ins continue the same sequence
// without colliding.
const sequencer = () => {
  let next = 0;
  return (event: ResponsesStreamEvent): ResponsesStreamEvent => {
    if (event.sequence_number !== undefined) {
      if (event.sequence_number >= next) next = event.sequence_number + 1;
      return event;
    }
    const stamped: ResponsesStreamEvent = { ...event, sequence_number: next };
    next++;
    return stamped;
  };
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
  const stamp = sequencer();

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
    if (((frame.data as { type?: string }).type ?? frame.frame.event) === 'ping') continue;

    const event = projectSseJsonEvent(frame.data, frame.frame.event);
    const structured = isStructuredResponsesEvent(event);
    const terminal = isResponsesTerminalEvent(event);

    if (!sawStructured && terminal && !structured && 'response' in event) {
      // Fast-path: terminal arrived before any content-bearing structured
      // event. If wrappers were already sent downstream, keep them and
      // synthesize only the missing item/content events plus terminal.
      // `responsesResultToEvents` numbers from 0; re-stamp each frame
      // through the per-stream sequencer so they continue the same sequence.
      for (const expanded of responsesResultToEvents((event as { response: ResponsesResult }).response)) {
        if (sentWrapperTypes.has(expanded.event.type)) continue;
        const restamped = { ...expanded.event, sequence_number: undefined } as ResponsesStreamEvent;
        yield eventFrame(stamp(restamped));
      }
      sawStructured = true;
      continue;
    }

    if (!sawStructured && structured) {
      sawStructured = true;
    }

    if (!sawStructured && (event.type === 'response.queued' || event.type === 'response.created' || event.type === 'response.in_progress')) sentWrapperTypes.add(event.type);
    yield eventFrame(stamp(event));
  }
})();
