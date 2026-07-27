import { sseFrame, type SseFrame } from '../../src/common/sse.ts';

// Test-only fixtures; intentionally not re-exported from ./common — only
// consumed via the explicit ./common/test-utils.ts relative import in *_test.ts.
export const sseFrameBody = (...frames: SseFrame[]): ReadableStream<Uint8Array> =>
  new Response(frames.map(f => `${f.event ? `event: ${f.event}\n` : ''}data: ${f.data}\n\n`).join('')).body!;

export { sseFrame };
