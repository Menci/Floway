import type { StreamRecorder } from './recorder.ts';
import { isStreamFact, type StreamFact } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

/** Records final protocol content before transport framing. Collection and streaming
 * consume the same recorded values; the wrapper preserves source object identity. */
export function recordStream<T extends ProtocolFrame<unknown>>(stream: AsyncIterable<T>, dump: StreamRecorder | null): AsyncIterable<T>;
export function recordStream<T>(stream: AsyncIterable<T>, dump: StreamRecorder | null, asFrame: (value: T) => ProtocolFrame<unknown> | null): AsyncIterable<T>;
export function recordStream<T>(
  stream: AsyncIterable<T>,
  dump: StreamRecorder | null,
  asFrame: (value: T) => ProtocolFrame<unknown> | null = value => value as ProtocolFrame<unknown>,
): AsyncIterable<T> {
  if (dump === null) return stream;

  const recording = dump.openStream();
  return {
    ...recording.fact,
    [Symbol.asyncIterator]: () => (async function* () {
      for await (const value of stream) {
        const frame = asFrame(value);
        if (frame !== null) await recording.frame(frame);
        yield value;
      }
      // Early return or failure leaves the recording incomplete.
      await recording.end();
    })(),
  };
}

/** Transport wrappers retain the same symbol-backed reference as their content stream. */
export const streamReferenceOf = (value: unknown): StreamFact | Record<string, never> =>
  isStreamFact(value) ? { ...value } : {};
