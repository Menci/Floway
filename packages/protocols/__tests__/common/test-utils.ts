import { sseFrame, type SseFrame } from '../../src/common/sse.ts';
import type { Result } from '@floway-dev/pipeline';

const sseText = (frames: SseFrame[]): string =>
  frames.map(f => `${f.event ? `event: ${f.event}\n` : ''}data: ${f.data}\n\n`).join('');

// Keep these fixtures package-private rather than adding them to the public
// `./common` export.
export const sseFrameBody = (...frames: SseFrame[]): ReadableStream<Uint8Array> =>
  new Response(sseText(frames)).body!;

export const sseByteStream = async function* (...frames: SseFrame[]): AsyncGenerator<Result<Uint8Array, never>> {
  yield { ok: true, value: new TextEncoder().encode(sseText(frames)) };
};

export { sseFrame };
