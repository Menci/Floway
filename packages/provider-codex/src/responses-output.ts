import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesOutputItem, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

// Codex can close messages and native compaction items but omit them from its
// terminal snapshot. Its CLI consumes output_item.done independently of that
// snapshot. Recover omissions using the stream's output_index, matching
// snapshot items by ID rather than treating a shortened array's positions as
// indices. OpenResponses specifies both representations, without prescribing
// precedence when they disagree.
// https://github.com/openai/codex/blob/0a2eb4696c/codex-rs/codex-api/src/sse/responses.rs#L357-L362
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2864-L2889
export const restoreCodexResponsesOutput = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
  const closedItems = new Map<number, OpenAIResponsesOutputItem>();
  const itemIndices = new Map<string, number>();
  const indexedIds = new Map<number, string>();
  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const event = frame.event;
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      if (event.item.id != null) {
        const previousIndex = itemIndices.get(event.item.id);
        if (previousIndex !== undefined && previousIndex !== event.output_index) {
          throw new TypeError(`Codex output item ${event.item.id} has conflicting output_index values ${previousIndex} and ${event.output_index}`);
        }
        const previousId = indexedIds.get(event.output_index);
        if (previousId !== undefined && previousId !== event.item.id) {
          throw new TypeError(`Codex output_index ${event.output_index} has conflicting item IDs ${previousId} and ${event.item.id}`);
        }
        itemIndices.set(event.item.id, event.output_index);
        indexedIds.set(event.output_index, event.item.id);
      }
    }
    if (event.type === 'response.output_item.done') {
      closedItems.set(event.output_index, event.item);
    }
    if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      const stated = event.response.output;
      const omitted = [...closedItems].some(([outputIndex, item]) => item.id == null
        ? stated[outputIndex]?.id != null || stated[outputIndex]?.type !== item.type
        : !stated.some(candidate => candidate.id === item.id));
      if (omitted) {
        const indexedOutput = new Map(closedItems);
        const statedIndices = new Set<number>();
        for (const item of stated) {
          const outputIndex = item.id == null ? undefined : itemIndices.get(item.id);
          if (outputIndex === undefined) {
            throw new TypeError(`Codex terminal output item ${item.id ?? item.type} has no observed output_index; cannot restore omitted output`);
          }
          if (statedIndices.has(outputIndex)) throw new TypeError(`Codex terminal output repeats output_index ${outputIndex}`);
          statedIndices.add(outputIndex);
          indexedOutput.set(outputIndex, item);
        }
        const output = [...indexedOutput].sort(([left], [right]) => left - right).map(([outputIndex, item], index) => {
          if (outputIndex !== index) throw new TypeError(`Codex terminal output is missing output_index ${index}`);
          return item;
        });
        yield eventFrame({ ...event, response: { ...event.response, output } });
        continue;
      }
    }
    yield frame;
  }
};
