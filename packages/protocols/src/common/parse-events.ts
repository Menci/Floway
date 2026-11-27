import type { JsonObject } from './json.ts';
import type { SseFrame, SseRawFrame } from './sse.ts';
import type { Result } from '@floway-dev/pipeline';

export interface ParseTargetStreamFramesOptions {
  protocol: string;
  malformedJsonEventName?: string;
  // Gemini accepts an upstream error written as a bare JSON line.
  onRawFrame?: boolean;
}

export interface ProtocolDecodeError {
  kind: 'protocol';
  cause: unknown;
  event?: JsonObject;
  eventName?: string;
}

export const protocolDecodeError = (
  message: string,
  cause?: unknown,
  event?: JsonObject,
  eventName?: string,
): Result<never, ProtocolDecodeError> => ({
  ok: false,
  error: {
    kind: 'protocol',
    cause: new Error(message, { cause }),
    ...(event === undefined ? {} : { event }),
    ...(eventName === undefined ? {} : { eventName }),
  },
});

export type ParsedTargetStreamFrame<TEvent> =
  | { type: 'done' }
  | { type: 'sse-json'; data: TEvent; frame: SseFrame }
  // A payload the upstream wrote without SSE framing. Only a protocol that
  // expects one opts in via `onRawFrame`; the rest skip it, as they always
  // dropped such lines.
  | { type: 'sse-raw'; data: TEvent; frame: SseRawFrame };

export const parseTargetStreamFrame = (
  frame: SseFrame | SseRawFrame,
  options: ParseTargetStreamFramesOptions,
): Result<ParsedTargetStreamFrame<unknown> | null, ProtocolDecodeError> => {
  if (frame.type === 'sse-raw' && options.onRawFrame !== true) return { ok: true, value: null };
  const data = frame.data.trim();
  if (!data) return { ok: true, value: null };
  if (data === '[DONE]') return { ok: true, value: { type: 'done' } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const eventName = frame.type === 'sse' ? frame.event : undefined;
    const name = eventName ?? options.malformedJsonEventName;
    const eventContext = name ? ` for event "${name}"` : '';
    return protocolDecodeError(`Malformed upstream ${options.protocol} SSE JSON${eventContext}: ${data}`, error, undefined, eventName);
  }

  return {
    ok: true,
    value: frame.type === 'sse-raw' ? { type: 'sse-raw', data: parsed, frame } : { type: 'sse-json', data: parsed, frame },
  };
};

export const parseTargetStreamFrames = async function* <TEvent>(
  frames: AsyncIterable<SseFrame | SseRawFrame>,
  options: ParseTargetStreamFramesOptions,
): AsyncGenerator<ParsedTargetStreamFrame<TEvent>> {
  for await (const frame of frames) {
    const result = parseTargetStreamFrame(frame, options);
    if (!result.ok) throw result.error.cause;
    if (result.value !== null) yield result.value as ParsedTargetStreamFrame<TEvent>;
  }
};
