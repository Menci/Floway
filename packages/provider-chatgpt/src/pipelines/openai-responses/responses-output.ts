import { chatgptFactSpace } from '../facts.ts';
import { isOpenAIResponsesTerminalEvent, type OpenAIResponsesOutputItemEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const { defineStage } = chatgptFactSpace;

export const normalizeOpenAIResponsesOutput = defineStage({
  name: 'chatgpt.openaiResponses.responses-output',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['response.openaiResponses'], provides: ['response.openaiResponses'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer['response.openaiResponses'];
    if (outcome.kind !== 'stream') return answer;
    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      const restoreOutput = createChatGPTResponsesOutputRestore();
      const cursor = producer.read(source);
      while (true) {
        const next = await cursor.next();
        if (next.done) return;
        const item = next.value;
        if (!item.ok) {
          yield item;
          continue;
        }

        const event = restoreOutput(item.value);
        // Codex ends its response at the terminal event, independently of HTTP EOF.
        // https://github.com/openai/codex/blob/0a2eb4696c/codex-rs/codex-api/src/sse/responses.rs#L357-L382
        const terminal = isOpenAIResponsesTerminalEvent(event);
        if (terminal) producer.discard(source);
        yield { ok: true, value: event };
        if (terminal) return;
      }
    });
    return { ...answer, 'response.openaiResponses': { kind: 'stream', stream } };
  },
});

export const MAX_CHATGPT_OUTPUT_INDICES = 4096;
const MAX_CHATGPT_OUTPUT_BYTES = 64 * 1024 * 1024;

// Codex can close messages and native compaction items but omit them from its
// terminal snapshot. Its CLI consumes output_item.done independently of that
// snapshot. Recover omissions using the stream's output_index, matching
// snapshot items by ID rather than treating a shortened array's positions as
// indices. OpenResponses specifies both representations, without prescribing
// precedence when they disagree.
// https://github.com/openai/codex/blob/0a2eb4696c/codex-rs/codex-api/src/sse/responses.rs#L357-L362
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2864-L2889
export const createChatGPTResponsesOutputRestore = () => {
  const closedItems = new Map<number, { item: OpenAIResponsesOutputItemEx; bytes: number }>();
  const itemIndices = new Map<string, number>();
  const indexedIds = new Map<number, string>();
  const utf8 = new TextEncoder();
  let retainedBytes = 0;
  const retain = (bytes: number) => {
    retainedBytes += bytes;
    if (retainedBytes > MAX_CHATGPT_OUTPUT_BYTES) throw new RangeError('ChatGPT Responses output repair exceeds 64 MiB');
  };
  return (event: OpenAIResponsesStreamEventEx): OpenAIResponsesStreamEventEx => {
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      if (event.item.id != null) {
        const previousIndex = itemIndices.get(event.item.id);
        if (previousIndex !== undefined && previousIndex !== event.output_index) {
          throw new TypeError(`ChatGPT output item ${event.item.id} has conflicting output_index values ${previousIndex} and ${event.output_index}`);
        }
        const previousId = indexedIds.get(event.output_index);
        if (previousId !== undefined && previousId !== event.item.id) {
          throw new TypeError(`ChatGPT output_index ${event.output_index} has conflicting item IDs ${previousId} and ${event.item.id}`);
        }
        if (previousIndex === undefined) {
          if (itemIndices.size >= MAX_CHATGPT_OUTPUT_INDICES) throw new RangeError(`ChatGPT Responses output repair exceeds ${MAX_CHATGPT_OUTPUT_INDICES} indices`);
          retain(utf8.encode(event.item.id).byteLength);
          itemIndices.set(event.item.id, event.output_index);
          indexedIds.set(event.output_index, event.item.id);
        }
      }
    }
    if (event.type === 'response.output_item.done') {
      const previous = closedItems.get(event.output_index);
      if (previous === undefined && closedItems.size >= MAX_CHATGPT_OUTPUT_INDICES) {
        throw new RangeError(`ChatGPT Responses output repair exceeds ${MAX_CHATGPT_OUTPUT_INDICES} closed items`);
      }
      const bytes = utf8.encode(JSON.stringify(event.item)).byteLength;
      retain(bytes - (previous?.bytes ?? 0));
      closedItems.set(event.output_index, { item: event.item, bytes });
    }
    if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      const stated = event.response.output;
      const omitted = [...closedItems].some(([outputIndex, { item }]) => item.id == null
        ? stated[outputIndex]?.id != null || stated[outputIndex]?.type !== item.type
        : !stated.some(candidate => candidate.id === item.id));
      if (omitted) {
        const indexedOutput = new Map([...closedItems].map(([outputIndex, { item }]) => [outputIndex, item]));
        const statedIndices = new Set<number>();
        for (const item of stated) {
          const outputIndex = item.id == null ? undefined : itemIndices.get(item.id);
          if (outputIndex === undefined) {
            throw new TypeError(`ChatGPT terminal output item ${item.id ?? item.type} has no observed output_index; cannot restore omitted output`);
          }
          if (statedIndices.has(outputIndex)) throw new TypeError(`ChatGPT terminal output repeats output_index ${outputIndex}`);
          statedIndices.add(outputIndex);
          indexedOutput.set(outputIndex, item);
        }
        const output = [...indexedOutput].sort(([left], [right]) => left - right).map(([outputIndex, item], index) => {
          if (outputIndex !== index) throw new TypeError(`ChatGPT terminal output is missing output_index ${index}`);
          return item;
        });
        return { ...event, response: { ...event.response, output } };
      }
    }
    return event;
  };
};
