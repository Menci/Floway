import type { SseErrorFrame, SseFrame, SseRawFrame } from './sse.ts';

export interface ParseTargetStreamFramesOptions {
  protocol: string;
  malformedJsonEventName?: string;
}

export type ParsedTargetStreamFrame<TEvent> =
  | { type: 'done' }
  | { type: 'sse-json'; data: TEvent; frame: SseFrame }
  // A payload the upstream wrote without SSE framing. Only a protocol that
  // expects one opts in via `onRawFrame`; the rest skip it, as they always
  // dropped such lines.
  | { type: 'sse-raw'; data: TEvent; frame: SseRawFrame }
  | SseErrorFrame;

// The unknown JSON payload becomes the target protocol's event type at this
// boundary; each protocol's stream parser names its event type when calling
// in. Each protocol-specific stream parser handles the decoded wire values.
export const parseTargetStreamFrames = async function* <TEvent>(frames: AsyncIterable<SseFrame | SseRawFrame>, options: ParseTargetStreamFramesOptions & {
  // Set by a protocol that treats an unframed payload as part of its stream.
  // Otherwise it is ignored, matching the previous behaviour where the SSE
  // grammar dropped such lines.
  onRawFrame?: boolean;
}): AsyncGenerator<ParsedTargetStreamFrame<TEvent>> {
  for await (const frame of frames) {
    if (frame.type === 'sse-raw' && options.onRawFrame !== true) continue;
    const data = frame.data.trim();
    if (!data) continue;
    if (data === '[DONE]') {
      yield { type: 'done' };
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const eventName = (frame.type === 'sse' ? frame.event : undefined) ?? options.malformedJsonEventName;
      const eventContext = eventName ? ` for event "${eventName}"` : '';
      yield { type: 'error', cause: { message: `Malformed upstream ${options.protocol} SSE JSON${eventContext}: ${data}`, cause: error } };
      return;
    }

    yield frame.type === 'sse-raw'
      ? { type: 'sse-raw', data: parsed as TEvent, frame }
      : { type: 'sse-json', data: parsed as TEvent, frame };
  }
};
