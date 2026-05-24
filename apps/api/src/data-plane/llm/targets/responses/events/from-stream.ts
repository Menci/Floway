import { parseTargetStreamFrames } from '../../events/from-stream.ts';
import { doneFrame, type EventFrame, eventFrame, type ProtocolFrame, type SseFrame } from '@floway-dev/protocols/common';
import { isResponsesTerminalEvent, type ResponsesResult, responsesResultToEvents, type ResponseStreamEvent, type SequencedResponsesStreamEvent } from '@floway-dev/protocols/responses';

// Deny-list: anything that is not a wrapper (`response.created` /
// `response.in_progress` / `ping`) and not terminal is treated as content-
// bearing. `ping` is a transport-level keep-alive with no content semantics, so
// its presence must not commit us out of the fast-path. Future Responses event
// types fall through as structured by default, which is safer than missing an
// allow-list entry and incorrectly triggering the fast-path expansion below.
const isStructuredResponsesEvent = (event: { type: string }): boolean =>
  event.type !== 'response.created'
  && event.type !== 'response.in_progress'
  && event.type !== 'ping'
  && !isResponsesTerminalEvent(event as ResponseStreamEvent);

// Some Responses upstreams emit the event type only via the SSE `event:`
// header and leave it off the JSON body; re-attach it so downstream sees a
// consistent shape.
const projectSseJsonEvent = (event: ResponseStreamEvent, eventName: string | undefined): SequencedResponsesStreamEvent =>
  eventName && !(event as { type?: string }).type ? ({ ...event, type: eventName } as SequencedResponsesStreamEvent) : (event as SequencedResponsesStreamEvent);

const isResponsesWrapperEvent = (event: Pick<ResponseStreamEvent, 'type'>): boolean =>
  event.type === 'response.created' || event.type === 'response.in_progress';

const remainingFastPathEvents = (response: ResponsesResult, sentWrapperTypes: ReadonlySet<ResponseStreamEvent['type']>): EventFrame<SequencedResponsesStreamEvent>[] => {
  const expanded = responsesResultToEvents(response);
  return sentWrapperTypes.size > 0 ? expanded.filter(frame => !sentWrapperTypes.has(frame.event.type)) : expanded;
};

// Some Responses upstreams (notably Copilot for short prompts) take a
// "fast-path": they only emit `response.created` / `response.in_progress` and a
// terminal `response.completed` / `response.incomplete` / `response.failed`,
// skipping every content-bearing structured event. Translate / source layers
// upstream-of-here used to special-case that with cross-frame buffering. Now
// the target boundary expands the terminal in place via responsesResultToEvents
// so downstream consumers always observe one canonical full event sequence.
// `error` terminals carry no `response` payload, so we cannot expand them;
// they continue to surface as their original frame for downstream handlers.
export const responsesStreamFramesToEvents = (frames: AsyncIterable<SseFrame>): AsyncGenerator<ProtocolFrame<SequencedResponsesStreamEvent>> =>
  (async function* () {
    let sawStructured = false;
    const sentWrapperTypes = new Set<ResponseStreamEvent['type']>();

    for await (const frame of parseTargetStreamFrames<ResponseStreamEvent>(frames, {
      protocol: 'Responses',
      malformedJsonEventName: 'response',
    })) {
      if (frame.type === 'done') {
        yield doneFrame();
        return;
      }

      const event = projectSseJsonEvent(frame.data, frame.frame.event);
      if (event.type === 'ping') continue;

      const structured = isStructuredResponsesEvent(event);
      const terminal = isResponsesTerminalEvent(event);
      const projected = eventFrame(event);

      if (!sawStructured && terminal && !structured && 'response' in event) {
        // Fast-path: terminal arrived before any content-bearing structured
        // event. If wrappers were already sent downstream, keep them and
        // synthesize only the missing item/content events plus terminal.
        for (const expanded of remainingFastPathEvents((event as { response: ResponsesResult }).response, sentWrapperTypes)) yield expanded;
        sawStructured = true;
        continue;
      }

      if (!sawStructured && structured) {
        sawStructured = true;
      }

      if (!sawStructured && isResponsesWrapperEvent(event)) sentWrapperTypes.add(event.type);
      yield projected;
    }
  })();
