import { openAIResponsesSseFrames } from './http-stream-frames.ts';
import { openaiInternalErrorPayload } from '../../shared/openai-errors.ts';
import type { HttpPanicPresentation } from '../../shared/pipeline-http.ts';
import { serializeSseFrame } from '../../shared/sse.ts';
import { getHeader } from '@floway-dev/http';
import { isEventStreamMediaType, isJsonObject, parseJSONWithRawNumbers } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { toInternalDebugError } from '@floway-dev/upstream';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export const openAIResponsesHttpPanicPresentation: HttpPanicPresentation = {
  response: error => Response.json(openaiInternalErrorPayload(toInternalDebugError(error)), { status: 502 }),
  stream(headers, dump) {
    const mediaType = getHeader(headers, 'content-type');
    if (typeof mediaType !== 'string' || !isEventStreamMediaType(mediaType)) return undefined;
    const frames = openAIResponsesSseFrames();
    return {
      delivered(bytes) {
        const wire = decoder.decode(bytes);
        if (!wire.startsWith('event: ')) return;
        // The Responses encoder emits one named event per chunk with compact JSON.
        const newline = wire.indexOf('\n');
        const start = newline + '\ndata: '.length;
        if (newline < 0 || !wire.startsWith('\ndata: ', newline) || !wire.endsWith('\n\n')) {
          throw new TypeError('Expected an encoded OpenAI Responses SSE event');
        }
        const event = parseJSONWithRawNumbers(wire.slice(start, -2));
        if (!isJsonObject(event) || event.type !== wire.slice('event: '.length, newline)) {
          throw new TypeError('OpenAI Responses SSE event name disagrees with its JSON');
        }
        frames.delivered(event as OpenAIResponsesStreamEventEx);
      },
      panic(error) {
        const trailer = frames.panic(error);
        if (trailer === undefined) return undefined;
        return encoder.encode(trailer.map(({ frame, wire }) => {
          if (frame !== undefined) dump?.frame(frame);
          return serializeSseFrame(wire);
        }).join(''));
      },
    };
  },
};
