import type { HttpPanicPresentation } from './pipeline-http.ts';
import { serializeSseFrame } from './sse.ts';
import { getHeader } from '@floway-dev/http';
import { isEventStreamMediaType, type ProtocolFrame, type SseWritableFrame } from '@floway-dev/protocols/common';

interface SsePanicFrame {
  readonly frame: ProtocolFrame<unknown>;
  readonly wire: SseWritableFrame;
}

const encoder = new TextEncoder();

export const sseHttpPanicPresentation = (
  status: number,
  render: (error: unknown) => unknown,
  frame: (error: unknown) => SsePanicFrame,
): HttpPanicPresentation => ({
  response: error => Response.json(render(error), { status }),
  stream(headers, dump) {
    const mediaType = getHeader(headers, 'content-type');
    if (typeof mediaType !== 'string' || !isEventStreamMediaType(mediaType)) return undefined;
    return {
      panic(error) {
        const rendered = frame(error);
        dump?.frame(rendered.frame);
        return encoder.encode(serializeSseFrame(rendered.wire));
      },
    };
  },
});
