import type { StreamFrame } from './encode.ts';
import type { HttpPanicPresentation } from '../../shared/pipeline-http.ts';
import { serializeSseFrame } from '../../shared/sse.ts';
import { getHeader } from '@floway-dev/http';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';

const encoder = new TextEncoder();

export const chatHttpPanicPresentation = (
  status: number,
  render: (error: unknown) => unknown,
  frame: (error: unknown) => StreamFrame,
): HttpPanicPresentation => ({
  response: error => Response.json(render(error), { status }),
  stream(headers, dump) {
    const mediaType = getHeader(headers, 'content-type');
    if (typeof mediaType !== 'string' || !isEventStreamMediaType(mediaType)) return undefined;
    return {
      panic(error) {
        const rendered = frame(error);
        if (rendered.frame !== undefined) dump?.frame(rendered.frame);
        return encoder.encode(serializeSseFrame(rendered.wire));
      },
    };
  },
});
