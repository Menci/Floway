import type { ClientResponseResource, ClientOpenAIResponsesStreamEvent } from './client-resource.ts';
import type { OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from './index.ts';
import type { ParsedProtocolFrame, SseErrorFrame } from '../common/sse.ts';
import type { Result } from '@floway-dev/pipeline';

export const OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE = 'OpenAI Responses stream ended without a terminal event.';

// Reassembly copies each response object through, so a stream whose frames
// already carry the completed client resource collects into a completed
// resource. The narrow signature comes first so overload resolution picks it
// exactly when the argument is narrow — `ClientOpenAIResponsesStreamEvent` is
// assignable to `OpenAIResponsesStreamEventEx`, so the wide signature would otherwise
// swallow both calls and widen the completed result back to `OpenAIResponsesResultEx`.
export function collectOpenAIResponsesProtocolEventsToResult(frames: AsyncIterable<ParsedProtocolFrame<ClientOpenAIResponsesStreamEvent>>): Promise<Result<ClientResponseResource, SseErrorFrame>>;
export function collectOpenAIResponsesProtocolEventsToResult(frames: AsyncIterable<ParsedProtocolFrame<OpenAIResponsesStreamEventEx>>): Promise<Result<OpenAIResponsesResultEx, SseErrorFrame>>;
export async function collectOpenAIResponsesProtocolEventsToResult(frames: AsyncIterable<ParsedProtocolFrame<OpenAIResponsesStreamEventEx>>): Promise<Result<OpenAIResponsesResultEx, SseErrorFrame>> {
  let error: Extract<OpenAIResponsesStreamEventEx, { type: 'error' }> | undefined;
  for await (const frame of frames) {
    if (frame.type === 'error') return { ok: false, error: frame };
    if (frame.type === 'done') continue;
    const event = frame.event;
    if (event.type === 'error') error = event;
    if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      if (event.type === 'response.failed' && error !== undefined) break;
      return { ok: true, value: event.response };
    }
  }
  const message = error === undefined
    ? OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE
    : 'message' in error ? error.message : error.error.message;
  const cause = new Error(message, error === undefined ? undefined : { cause: error });
  return { ok: false, error: { type: 'error', cause } };
}
