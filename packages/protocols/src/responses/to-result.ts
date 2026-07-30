import type { ClientResponseResource, ClientResponsesStreamEvent } from './client-resource.ts';
import { isResponsesTerminalEvent, type ResponsesResult, type ResponsesStreamEvent } from './index.ts';
import { reassembleResponsesEvents } from './reassemble.ts';
import { type ProtocolFrame } from '../common/index.ts';

export const RESPONSES_MISSING_TERMINAL_MESSAGE = 'Responses stream ended without a terminal event.';

// Reassembly copies each response object through, so a stream whose frames
// already carry the completed client resource collects into a completed
// resource. The narrow signature comes first so overload resolution picks it
// exactly when the argument is narrow — `ClientResponsesStreamEvent` is
// assignable to `ResponsesStreamEvent`, so the wide signature would otherwise
// swallow both calls and widen the completed result back to `ResponsesResult`.
export function collectResponsesProtocolEventsToResult(frames: AsyncIterable<ProtocolFrame<ClientResponsesStreamEvent>>): Promise<ClientResponseResource>;
export function collectResponsesProtocolEventsToResult(frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): Promise<ResponsesResult>;
export async function collectResponsesProtocolEventsToResult(frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): Promise<ResponsesResult> {
  const events = async function* (): AsyncGenerator<ResponsesStreamEvent> {
    for await (const frame of frames) {
      if (frame.type === 'done') continue;

      yield frame.event;
      if (isResponsesTerminalEvent(frame.event)) return;
    }

    throw new Error(RESPONSES_MISSING_TERMINAL_MESSAGE);
  };

  return await reassembleResponsesEvents(events());
}
