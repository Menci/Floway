import { MAX_CHAT_COLLECTION_BYTES } from '../../pipeline/collect.ts';
import { isOpenAIResponsesTerminalEvent, type OpenAIResponsesOutputItemEx, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export class OpenAIResponsesInterruption extends Error {
  constructor() {
    super('Responses generation interrupted by the client.');
  }
}

const encoder = new TextEncoder();
const maxPendingItems = 4096;

export const trackOpenAIResponsesOutput = (responseId: string) => {
  let response: OpenAIResponsesResultEx | undefined;
  let terminal = false;
  let completedBytes = 0;
  let sequence = 0;
  const pending = new Map<number, string>();
  const completed = new Map<number, { item: OpenAIResponsesOutputItemEx; bytes: number }>();

  return {
    observe(event: OpenAIResponsesStreamEventEx) {
      if (event.sequence_number !== undefined) sequence = Math.max(sequence, event.sequence_number + 1);
      if ('response' in event) response = event.response;
      if (event.type === 'response.output_item.added' && typeof event.item.id === 'string') {
        pending.set(event.output_index, event.item.id);
        if (pending.size > maxPendingItems) throw new RangeError(`OpenAI Responses interruption tracks at most ${maxPendingItems} pending items`);
      }
      if (event.type === 'response.output_item.done') {
        pending.delete(event.output_index);
        const bytes = encoder.encode(JSON.stringify(event.item)).byteLength;
        completedBytes += bytes - (completed.get(event.output_index)?.bytes ?? 0);
        if (completedBytes > MAX_CHAT_COLLECTION_BYTES) {
          throw new RangeError(`OpenAI Responses interruption output exceeds the ${MAX_CHAT_COLLECTION_BYTES}-byte limit`);
        }
        completed.set(event.output_index, { item: event.item, bytes });
      }
      if (isOpenAIResponsesTerminalEvent(event)) {
        terminal = true;
        pending.clear();
        completed.clear();
      }
    },
    // https://github.com/openai/codex/blob/12de0e395d3313bc564190d983cb4f5acf0be713/codex-rs/core/tests/suite/pending_input.rs#L1140-L1168
    *interrupt(): Generator<OpenAIResponsesStreamEventEx> {
      if (terminal || response === undefined) return;
      for (const [outputIndex, itemId] of [...pending].sort(([left], [right]) => left - right)) {
        yield {
          type: 'response.output_item.interrupted',
          response_id: responseId,
          item_id: itemId,
          output_index: outputIndex,
          sequence_number: sequence++,
        };
      }
      yield {
        type: 'response.incomplete',
        sequence_number: sequence,
        response: {
          ...response,
          id: responseId,
          output: [...completed].sort(([left], [right]) => left - right).map(([, { item }]) => item),
          status: 'incomplete',
          error: null,
          incomplete_details: { reason: 'interrupted' },
        },
      };
    },
  };
};
