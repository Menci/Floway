import { sseFrame, type SseFrame } from '../../src/common/sse.ts';

// Keep these fixtures package-private rather than adding them to the public
// `./common` export.
export const sseFrameBody = (...frames: SseFrame[]): ReadableStream<Uint8Array> =>
  new Response(frames.map(f => `${f.event ? `event: ${f.event}\n` : ''}data: ${f.data}\n\n`).join('')).body!;

export { sseFrame };
