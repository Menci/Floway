import { readProtocolFrames } from './protocol-frames.ts';
import type { ManagedStream, Result } from '@floway-dev/pipeline';
import type { ProtocolFrame, SseErrorFrame } from '@floway-dev/protocols/common';
import type { ProtocolError, ProtocolStreamError } from '@floway-dev/provider';

interface CollectionLimits {
  readonly bytes: number;
  readonly frames: number;
}

// 64 MiB leaves room for large text and base64 media responses. A separate
// one-million-frame cap bounds accumulator overhead from many small events.
const limitsForChatCollection: CollectionLimits = { bytes: 64 * 1024 * 1024, frames: 1_000_000 };
const utf8 = new TextEncoder();

class ChatCollectionOverflow extends RangeError {}

const boundedFrames = async function* <Event>(
  frames: AsyncIterable<ProtocolFrame<Event>>,
  limits: CollectionLimits,
): AsyncGenerator<ProtocolFrame<Event>> {
  let bytes = 0;
  let count = 0;
  for await (const frame of frames) {
    if (++count > limits.frames) throw new ChatCollectionOverflow(`Chat response collection exceeded ${limits.frames} frames`);
    const text = JSON.stringify(frame);
    bytes += utf8.encode(text).byteLength;
    if (bytes > limits.bytes) throw new ChatCollectionOverflow(`Chat response collection exceeded ${limits.bytes} bytes`);
    yield frame;
  }
};

export const collectChatOutcome = async <Event, Output, ErrorBody>(
  stream: ManagedStream<Event, ProtocolStreamError>,
  scope: { readonly abort: () => void },
  collect: (frames: AsyncIterable<ProtocolFrame<Event>>) => Promise<Result<Output, SseErrorFrame>>,
  formatError: (message: string, cause: unknown) => ErrorBody,
  limits: CollectionLimits = limitsForChatCollection,
): Promise<{ readonly kind: 'result'; readonly result: Output } | ProtocolError<ErrorBody>> => {
  const source = readProtocolFrames(stream);
  let outcome: { readonly kind: 'result'; readonly result: Output } | ProtocolError<ErrorBody>;
  try {
    const result = await collect(boundedFrames(source.frames(), limits));
    if (result.ok) {
      outcome = { kind: 'result', result: result.value };
    } else {
      const { cause } = result.error;
      outcome = { kind: 'error', source: 'upstream', error: formatError(cause.message, cause), cause };
    }
  } catch (cause) {
    const failure = source.failure;
    const overflow = cause instanceof ChatCollectionOverflow;
    if (!overflow && (failure === undefined || cause !== failure)) throw cause;
    const detail = failure !== undefined && cause === failure ? failure.cause : cause;
    const message = detail instanceof Error ? detail.message : String(detail);
    outcome = {
      kind: 'error',
      source: overflow ? 'local' : 'upstream',
      error: formatError(message, detail),
      cause,
    };
  }
  if (!source.done) scope.abort();
  await source.drain();
  return outcome;
};
