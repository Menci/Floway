// Reading a streamed answer. Both endpoints accept `stream: true` and answer with SSE that
// carries the same two shapes under their own names — `image_generation.partial_image` and
// `image_generation.completed` on generations, `image_edit.*` on edits — and the sequence ends
// at the completed event rather than at a sentinel: this protocol has no `[DONE]`.
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L13077-L13086
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L12846-L12857

import type { OpenAIImagesStreamEvent } from './index.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';

export interface ParseOpenAIImagesStreamOptions {
  signal?: AbortSignal;
}

export const OPENAI_IMAGES_MISSING_TERMINAL_MESSAGE = 'OpenAI Images stream ended without a completed event.';

/** The stream is over when the image is. Each endpoint names its own terminal —
 *  `image_generation.completed` and `image_edit.completed` — so the suffix is the whole of
 *  what the two have in common, which is also what makes this reading serve an endpoint added
 *  later without being taught its prefix. */
export const isOpenAIImagesTerminalEvent = (event: OpenAIImagesStreamEvent): boolean => event.type.endsWith('.completed');

/**
 * The upstream's SSE body as this protocol's events. Transport framing ends here: what comes
 * out carries OpenAI Images events, and nothing that reads them knows how they arrived.
 */
export const parseOpenAIImagesStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseOpenAIImagesStreamOptions = {},
): AsyncGenerator<OpenAIImagesStreamEvent> => (async function* () {
  for await (const frame of parseTargetStreamFrames<Record<string, unknown>>(parseSSEStream(body, options), { protocol: 'OpenAI Images' })) {
    // `[DONE]` is not part of this protocol. An OpenAI-compatible upstream that appends the
    // sentinel it writes elsewhere is saying the body is over, which is all it can mean here —
    // whether the image finished is what the completed event says, and that has already passed.
    if (frame.type === 'done') return;
    yield named(frame.data, frame.frame.event);
  }
})();

/** The event's own name, which the specification writes twice: as the SSE `event:` label and
 *  as `type` inside the payload. Upstreams that write only the label have been seen on the
 *  Responses protocol, and every reader here takes the name off the payload, so the two are
 *  reconciled once at the boundary rather than at each reader. An event that carries neither
 *  is not one this protocol can place — it could be the terminal or a partial — so it ends the
 *  read rather than being passed on as an unknown. */
const named = (event: Record<string, unknown>, label: string | undefined): OpenAIImagesStreamEvent => {
  if (typeof event.type === 'string') return event as OpenAIImagesStreamEvent;
  if (label === undefined) throw new Error('OpenAI Images stream event carries no type, on the payload or as an SSE event name');
  return { ...event, type: label } as OpenAIImagesStreamEvent;
};
