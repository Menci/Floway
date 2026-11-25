import type { Result } from '@floway-dev/pipeline';
import type { OpenAIResponsesOutputItemEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/provider';

// Codex can close messages and native compaction items but omit them from its
// terminal snapshot. Its CLI consumes output_item.done independently of that
// snapshot. Recover omissions using the stream's output_index, matching
// snapshot items by ID rather than treating a shortened array's positions as
// indices. OpenResponses specifies both representations, without prescribing
// precedence when they disagree.
// https://github.com/openai/codex/blob/0a2eb4696c/codex-rs/codex-api/src/sse/responses.rs#L357-L362
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2864-L2889
export const createChatGPTResponsesOutputRestore = () => {
  const closedItems = new Map<number, OpenAIResponsesOutputItemEx>();
  const itemIndices = new Map<string, number>();
  const indexedIds = new Map<number, string>();
  return (event: OpenAIResponsesStreamEventEx): Result<OpenAIResponsesStreamEventEx, ProtocolStreamError> => {
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      if (event.item.id != null) {
        const previousIndex = itemIndices.get(event.item.id);
        if (previousIndex !== undefined && previousIndex !== event.output_index) {
          return { ok: false, error: { kind: 'protocol', cause: new TypeError(`ChatGPT output item ${event.item.id} has conflicting output_index values ${previousIndex} and ${event.output_index}`) } };
        }
        const previousId = indexedIds.get(event.output_index);
        if (previousId !== undefined && previousId !== event.item.id) {
          return { ok: false, error: { kind: 'protocol', cause: new TypeError(`ChatGPT output_index ${event.output_index} has conflicting item IDs ${previousId} and ${event.item.id}`) } };
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
            return { ok: false, error: { kind: 'protocol', cause: new TypeError(`ChatGPT terminal output item ${item.id ?? item.type} has no observed output_index; cannot restore omitted output`) } };
          }
          if (statedIndices.has(outputIndex)) return { ok: false, error: { kind: 'protocol', cause: new TypeError(`ChatGPT terminal output repeats output_index ${outputIndex}`) } };
          statedIndices.add(outputIndex);
          indexedOutput.set(outputIndex, item);
        }
        const output: OpenAIResponsesOutputItemEx[] = [];
        for (const [outputIndex, item] of [...indexedOutput].sort(([left], [right]) => left - right)) {
          if (outputIndex !== output.length) return { ok: false, error: { kind: 'protocol', cause: new TypeError(`ChatGPT terminal output is missing output_index ${output.length}`) } };
          output.push(item);
        }
        return { ok: true, value: { ...event, response: { ...event.response, output } } };
      }
    }
    return { ok: true, value: event };
  };
};
