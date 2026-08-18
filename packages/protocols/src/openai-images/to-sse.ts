import type { OpenAIImagesStreamEvent } from './index.ts';
import { type SseFrame, sseFrame } from '../common/index.ts';

// The specification writes an event's name twice — as the SSE `event:` label and as `type`
// inside the payload — and the stream parser reconciles the two on the way in, so writing the
// label back off the payload writes the name that arrived.
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L13077-L13086
export const openaiImagesStreamEventToSSEFrame = (event: OpenAIImagesStreamEvent): SseFrame =>
  sseFrame(JSON.stringify(event), event.type);
