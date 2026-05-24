import type { SseFrame } from '@floway-dev/protocols/common';

export interface ParseTargetStreamFramesOptions {
  protocol: string;
  malformedJsonEventName?: string;
}

export type ParsedTargetStreamFrame<TEvent> = { type: 'done' } | { type: 'sse-json'; data: TEvent; frame: SseFrame };

// The unknown JSON payload becomes the target protocol's event type at this
// boundary; each protocol's stream parser names its event type when calling
// in. Runtime narrowing happens upstream (parse error -> Error with cause)
// and downstream (per-event handling in target events/from-stream.ts).
export const parseTargetStreamFrames = async function* <TEvent>(frames: AsyncIterable<SseFrame>, options: ParseTargetStreamFramesOptions): AsyncGenerator<ParsedTargetStreamFrame<TEvent>> {
  for await (const frame of frames) {
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
      const eventName = frame.event ?? options.malformedJsonEventName;
      const eventContext = eventName ? ` for event "${eventName}"` : '';
      throw new Error(`Malformed upstream ${options.protocol} SSE JSON${eventContext}: ${data}`, { cause: error });
    }

    yield { type: 'sse-json', data: parsed as TEvent, frame };
  }
};
