import type { ClientResponseResource, ClientOpenAIResponsesStreamEvent } from './client-resource.ts';
import type { OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from './index.ts';
import { reassembleOpenAIResponsesEvents } from './reassemble.ts';
import { isOpenAIResponsesTerminalEvent } from './terminal-event.ts';
import { type ProtocolFrame } from '../common/index.ts';

export const OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE = 'OpenAI Responses stream ended without a terminal event.';

// Reassembly copies each response object through, so a stream whose frames
// already carry the completed client resource collects into a completed
// resource. The narrow signature comes first so overload resolution picks it
// exactly when the argument is narrow — `ClientOpenAIResponsesStreamEvent` is
// assignable to `OpenAIResponsesStreamEventEx`, so the wide signature would otherwise
// swallow both calls and widen the completed result back to `OpenAIResponsesResultEx`.
export function collectOpenAIResponsesProtocolEventsToResult(frames: AsyncIterable<ProtocolFrame<ClientOpenAIResponsesStreamEvent>>): Promise<ClientResponseResource>;
export function collectOpenAIResponsesProtocolEventsToResult(frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>): Promise<OpenAIResponsesResultEx>;
export async function collectOpenAIResponsesProtocolEventsToResult(frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>): Promise<OpenAIResponsesResultEx> {
  const events = async function* (): AsyncGenerator<OpenAIResponsesStreamEventEx> {
    for await (const frame of frames) {
      if (frame.type === 'done') continue;

      yield frame.event;
      if (isOpenAIResponsesTerminalEvent(frame.event)) return;
    }

    throw new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE);
  };

  return await reassembleOpenAIResponsesEvents(events());
}
