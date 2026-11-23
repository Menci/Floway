export class UpstreamStreamProtocolError extends Error {
  override readonly name = 'UpstreamStreamProtocolError';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

import type { SseFrame, SseRawFrame } from './sse.ts';

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
  | { type: 'sse-raw'; data: TEvent; frame: SseRawFrame };

// The unknown JSON payload becomes the target protocol's event type at this
// boundary; each protocol's stream parser names its event type when calling
// in. Runtime narrowing happens upstream (parse error -> Error with cause)
// and downstream in each protocol-specific stream parser.
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
      const eventName = (frame.type === 'sse' ? frame.event : undefined) ?? options.malformedJsonEventName;
      const eventContext = eventName ? ` for event "${eventName}"` : '';
      throw new UpstreamStreamProtocolError(`Malformed upstream ${options.protocol} SSE JSON${eventContext}: ${data}`, { cause: error });
    }

    yield frame.type === 'sse-raw'
      ? { type: 'sse-raw', data: parsed as TEvent, frame }
      : { type: 'sse-json', data: parsed as TEvent, frame };
  }
};
