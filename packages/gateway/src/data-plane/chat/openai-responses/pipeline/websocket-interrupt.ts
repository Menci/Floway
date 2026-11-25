import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { isOpenAIResponsesTerminalEvent, type OpenAIResponsesOutputItemEx, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export class OpenAIResponsesInterrupted extends Error {
  constructor() {
    super('Responses generation interrupted by the client.');
    this.name = 'AbortError';
  }
}

// Codex expects one interrupted event per partial item, followed by a response
// containing the completed items it can reference on the next turn.
// https://github.com/openai/codex/blob/12de0e395d3313bc564190d983cb4f5acf0be713/codex-rs/core/tests/suite/pending_input.rs#L1140-L1168
export const completeInterruptedOpenAIResponses = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  { signal, responseId, model }: { readonly signal: AbortSignal; readonly responseId: string; readonly model: string },
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  const completedItems = new Map<number, OpenAIResponsesOutputItemEx>();
  const pendingItems = new Map<number, string>();
  let response: OpenAIResponsesResultEx | undefined;
  let nextSequence = 0;
  let terminal = false;
  const interrupted = () => signal.aborted && signal.reason instanceof OpenAIResponsesInterrupted;

  try {
    for await (const frame of frames) {
      if (interrupted()) break;
      if (frame.type === 'event') {
        const event = frame.event;
        if (typeof event.sequence_number === 'number') nextSequence = Math.max(nextSequence, event.sequence_number + 1);
        if ('response' in event) response = event.response;
        if (event.type === 'response.output_item.added' && typeof event.item.id === 'string') {
          pendingItems.set(event.output_index, event.item.id);
        }
        if (event.type === 'response.output_item.done') {
          pendingItems.delete(event.output_index);
          completedItems.set(event.output_index, event.item);
        }
        terminal ||= isOpenAIResponsesTerminalEvent(event);
      }
      yield frame;
    }
  } catch (error) {
    if (!interrupted()) throw error;
  }

  if (!interrupted() || terminal) return;
  for (const [outputIndex, itemId] of [...pendingItems].sort(([left], [right]) => left - right)) {
    yield eventFrame({
      type: 'response.output_item.interrupted',
      response_id: responseId,
      item_id: itemId,
      output_index: outputIndex,
      sequence_number: nextSequence++,
    });
  }

  const output = [...completedItems].sort(([left], [right]) => left - right).map(([, item]) => item);
  yield eventFrame({
    type: 'response.incomplete',
    sequence_number: nextSequence,
    response: {
      ...response,
      id: response?.id ?? responseId,
      object: response?.object ?? 'response',
      model: response?.model ?? model,
      status: 'incomplete',
      output,
      error: null,
      incomplete_details: { reason: 'interrupted' },
    },
  });
};
