import { sseFrame, type SseFrame } from '../../src/common/sse.ts';

// Keep these fixtures package-private rather than adding them to the public
// `./common` export.
const encoder = new TextEncoder();

export const byteStream = (...chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });

export const sseFrameBody = (...frames: SseFrame[]): ReadableStream<Uint8Array> =>
  byteStream(frames.map(f => `${f.event ? `event: ${f.event}\n` : ''}data: ${f.data}\n\n`).join(''));

export const collectAsync = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
};

export { sseFrame };
