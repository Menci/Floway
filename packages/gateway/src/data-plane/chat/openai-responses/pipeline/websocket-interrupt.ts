import { eventFrame, type ParsedProtocolFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { isOpenAIResponsesTerminalEvent, type OpenAIResponsesOutputItemEx, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/provider';

export class OpenAIResponsesInterrupted extends Error {
  constructor() {
    super('Responses generation interrupted by the client.');
    this.name = 'AbortError';
  }
}

interface InterruptLimits { readonly bytes: number; readonly items: number }

// An interrupted turn reconstructs its terminal resource from completed
// items. Match collection's media budget and cap output-index bookkeeping.
const interruptLimits: InterruptLimits = { bytes: 64 * 1024 * 1024, items: 1_000_000 };
const utf8 = new TextEncoder();

// Codex expects one interrupted event per partial item, followed by a response
// containing the completed items it can reference on the next turn.
// https://github.com/openai/codex/blob/12de0e395d3313bc564190d983cb4f5acf0be713/codex-rs/core/tests/suite/pending_input.rs#L1140-L1168
export const completeInterruptedOpenAIResponses = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  { failure, responseId, model }: {
    readonly failure: () => ProtocolStreamError | undefined;
    readonly responseId: string;
    readonly model: string;
  },
  limits: InterruptLimits = interruptLimits,
): AsyncGenerator<ParsedProtocolFrame<OpenAIResponsesStreamEventEx>> {
  const completedItems = new Map<number, { readonly item: OpenAIResponsesOutputItemEx; readonly bytes: number }>();
  const pendingItems = new Map<number, string>();
  let response: Omit<OpenAIResponsesResultEx, 'output'> | undefined;
  let retainedBytes = 0;
  let nextSequence = 0;
  let terminal = false;
  try {
    for await (const frame of frames) {
      if (frame.type === 'event') {
        const event = frame.event;
        if (typeof event.sequence_number === 'number') nextSequence = Math.max(nextSequence, event.sequence_number + 1);
        if ('response' in event) {
          const { output: _output, ...head } = event.response;
          response = head;
        }
        if (event.type === 'response.output_item.added' && typeof event.item.id === 'string') {
          pendingItems.set(event.output_index, event.item.id);
        }
        if (event.type === 'response.output_item.done') {
          pendingItems.delete(event.output_index);
          const previous = completedItems.get(event.output_index);
          const bytes = utf8.encode(JSON.stringify(event.item)).byteLength;
          retainedBytes += bytes - (previous?.bytes ?? 0);
          if (retainedBytes > limits.bytes) {
            const cause = new RangeError(`OpenAI Responses interruption exceeded ${limits.bytes} retained bytes`);
            yield { type: 'error', cause };
            return;
          }
          completedItems.set(event.output_index, { item: event.item, bytes });
        }
        if (completedItems.size + pendingItems.size > limits.items) {
          const cause = new RangeError(`OpenAI Responses interruption exceeded ${limits.items} retained items`);
          yield { type: 'error', cause };
          return;
        }
        terminal ||= isOpenAIResponsesTerminalEvent(event);
      }
      yield frame;
    }
    return;
  } catch (error) {
    const source = failure();
    if (source?.kind !== 'abort' || error !== source || !(source.cause instanceof OpenAIResponsesInterrupted)) throw error;
  }

  if (terminal) return;
  for (const [outputIndex, itemId] of [...pendingItems].sort(([left], [right]) => left - right)) {
    yield eventFrame({
      type: 'response.output_item.interrupted',
      response_id: responseId,
      item_id: itemId,
      output_index: outputIndex,
      sequence_number: nextSequence++,
    });
  }

  const output = [...completedItems].sort(([left], [right]) => left - right).map(([, { item }]) => item);
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
