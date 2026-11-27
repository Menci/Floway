import type { Result } from '@floway-dev/pipeline';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesOutputItemEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const MAX_INDEXED_OUTPUT_ITEMS = 16_384;
const MAX_RESTORED_OUTPUT_BYTES = 64 * 1024 * 1024;
const invalidOutput = (message: string): Result<never, TypeError> => ({ ok: false, error: new TypeError(message) });

// Codex can close messages and native compaction items but omit them from its
// terminal snapshot. Its CLI consumes output_item.done independently of that
// snapshot. Recover omissions using the stream's output_index, matching
// snapshot items by ID rather than treating a shortened array's positions as
// indices. OpenResponses specifies both representations, without prescribing
// precedence when they disagree.
// https://github.com/openai/codex/blob/0a2eb4696c/codex-rs/codex-api/src/sse/responses.rs#L357-L362
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2864-L2889
export const createChatGPTResponsesOutputRestorer = (): (
  event: OpenAIResponsesStreamEventEx,
) => Result<OpenAIResponsesStreamEventEx, TypeError> => {
  const closedItems = new Map<number, { item: OpenAIResponsesOutputItemEx; size: number }>();
  const itemIndices = new Map<string, number>();
  const indexedIds = new Map<number, string>();
  const encoder = new TextEncoder();
  let retainedBytes = 0;
  let retainedIdBytes = 0;
  return event => {
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      if (event.item.id != null) {
        const previousIndex = itemIndices.get(event.item.id);
        if (previousIndex !== undefined && previousIndex !== event.output_index) {
          return invalidOutput(`ChatGPT output item ${event.item.id} has conflicting output_index values ${previousIndex} and ${event.output_index}`);
        }
        const previousId = indexedIds.get(event.output_index);
        if (previousId !== undefined && previousId !== event.item.id) {
          return invalidOutput(`ChatGPT output_index ${event.output_index} has conflicting item IDs ${previousId} and ${event.item.id}`);
        }
        if (previousIndex === undefined) {
          if (itemIndices.size >= MAX_INDEXED_OUTPUT_ITEMS) throw new RangeError('ChatGPT Responses output item index exceeds 16384 items');
          retainedIdBytes += encoder.encode(event.item.id).length;
          if (retainedIdBytes + retainedBytes > MAX_RESTORED_OUTPUT_BYTES) throw new RangeError('ChatGPT Responses output restoration exceeds 64 MiB');
        }
        itemIndices.set(event.item.id, event.output_index);
        indexedIds.set(event.output_index, event.item.id);
      }
    }
    if (event.type === 'response.output_item.done') {
      const previous = closedItems.get(event.output_index);
      if (previous === undefined && closedItems.size >= MAX_INDEXED_OUTPUT_ITEMS) throw new RangeError('ChatGPT Responses closed output exceeds 16384 items');
      const size = encoder.encode(JSON.stringify(event.item)).length;
      retainedBytes += size - (previous?.size ?? 0);
      if (retainedIdBytes + retainedBytes > MAX_RESTORED_OUTPUT_BYTES) throw new RangeError('ChatGPT Responses output restoration exceeds 64 MiB');
      closedItems.set(event.output_index, { item: event.item, size });
    }
    if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      const stated = event.response.output;
      const statedIds = new Set(stated.map(item => item.id));
      const omitted = [...closedItems].some(([outputIndex, { item }]) => item.id == null
        ? stated[outputIndex]?.id != null || stated[outputIndex]?.type !== item.type
        : !statedIds.has(item.id));
      if (omitted) {
        const indexedOutput = new Map([...closedItems].map(([index, { item }]) => [index, item]));
        const statedIndices = new Set<number>();
        for (const item of stated) {
          const outputIndex = item.id == null ? undefined : itemIndices.get(item.id);
          if (outputIndex === undefined) {
            return invalidOutput(`ChatGPT terminal output item ${item.id ?? item.type} has no observed output_index; cannot restore omitted output`);
          }
          if (statedIndices.has(outputIndex)) return invalidOutput(`ChatGPT terminal output repeats output_index ${outputIndex}`);
          statedIndices.add(outputIndex);
          indexedOutput.set(outputIndex, item);
        }
        const output: OpenAIResponsesOutputItemEx[] = [];
        for (const [outputIndex, item] of [...indexedOutput].sort(([left], [right]) => left - right)) {
          if (outputIndex !== output.length) return invalidOutput(`ChatGPT terminal output is missing output_index ${output.length}`);
          output.push(item);
        }
        return { ok: true, value: { ...event, response: { ...event.response, output } } };
      }
    }
    return { ok: true, value: event };
  };
};

export const restoreChatGPTResponsesOutput = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  const restore = createChatGPTResponsesOutputRestorer();
  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const restored = restore(frame.event);
    if (!restored.ok) throw restored.error;
    yield eventFrame(restored.value);
  }
};
