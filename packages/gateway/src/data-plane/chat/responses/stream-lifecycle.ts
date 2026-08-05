import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { RESPONSES_MISSING_TERMINAL_MESSAGE, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';

export const isResponsesResponseTerminalEvent = (
  event: Pick<ResponsesStreamEvent, 'type'>,
): boolean =>
  event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed';

const responseSnapshot = (event: ResponsesStreamEvent): ResponsesResult | undefined => {
  switch (event.type) {
  case 'response.queued':
  case 'response.created':
  case 'response.in_progress':
    return event.response;
  default:
    return undefined;
  }
};

// The upstream transport sentinel is never a client-facing success signal by
// itself. A response terminal owns that decision; if an upstream error omits
// the response.failed event the protocol requires after it, close the observed
// response with that event before either transport sees the stream end. Once a
// response terminal appears it remains the last visible frame, while the
// iterator still drains to EOF so provider metadata and accounting can settle.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L430
export const normalizeResponsesStreamLifecycle = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const iterator = frames[Symbol.asyncIterator]();
  let sourceOpen = true;
  let announced: ResponsesResult | undefined;
  let upstreamError: Extract<ResponsesStreamEvent, { type: 'error' }> | undefined;
  let lastSequenceNumber: number | undefined;
  let terminalSeen = false;

  const readSource = async (): Promise<IteratorResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    try {
      const next = await iterator.next();
      if (next.done) sourceOpen = false;
      return next;
    } catch (error) {
      sourceOpen = false;
      throw error;
    }
  };

  try {
    while (true) {
      const next = await readSource();
      if (next.done) break;
      const frame = next.value;
      if (terminalSeen || frame.type === 'done') continue;

      const event = frame.event;
      const snapshot = responseSnapshot(event);
      if (snapshot !== undefined) announced = snapshot;
      if (event.type === 'error') upstreamError = event;
      if (event.sequence_number !== undefined) lastSequenceNumber = event.sequence_number;

      yield frame;
      if (isResponsesResponseTerminalEvent(event)) terminalSeen = true;
    }
  } finally {
    while (sourceOpen) await readSource();
  }

  if (terminalSeen) return;

  if (announced !== undefined && upstreamError !== undefined) {
    yield eventFrame({
      type: 'response.failed',
      response: {
        ...announced,
        status: 'failed',
        error: {
          code: upstreamError.code ?? 'server_error',
          message: upstreamError.message,
        },
        incomplete_details: null,
      },
      ...(lastSequenceNumber === undefined ? {} : { sequence_number: lastSequenceNumber + 1 }),
    });
    return;
  }

  throw new Error(RESPONSES_MISSING_TERMINAL_MESSAGE);
};
