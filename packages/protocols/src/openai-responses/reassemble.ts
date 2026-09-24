import type { OpenAIResponsesOutputItem, OpenAIResponsesResult, OpenAIResponsesStreamEvent } from './index.ts';

type OpenAIResponsesReassembleEvent =
  | OpenAIResponsesStreamEvent
  | {
    type: 'error';
    message?: string;
  };

// The spec makes the item lifecycle the authority and requires nothing of the
// terminal's `output`. A Codex upstream leaves it empty after closing a remote
// compaction item, and states one that omits the assistant message it just
// closed, so the closed items in `output_index` order replace it, as the
// client-facing egress does. A turn that closed nothing keeps the terminal.
// https://github.com/openai/codex/blob/0a2eb4696c/codex-rs/codex-api/src/sse/responses.rs
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L313-L337
export async function reassembleOpenAIResponsesEvents(events: AsyncIterable<OpenAIResponsesReassembleEvent>): Promise<OpenAIResponsesResult> {
  const closedItems = new Map<number, OpenAIResponsesOutputItem>();

  for await (const event of events) {
    const rawEvent = event as unknown as Record<string, unknown>;
    const type = rawEvent.type as string;

    if (type === 'error') {
      const message = (rawEvent.message as string | undefined) ?? JSON.stringify(event);
      throw new Error(`Upstream SSE error: ${message}`);
    }

    if (type === 'response.output_item.done') {
      const outputIndex = rawEvent.output_index as number | undefined;
      const item = rawEvent.item as OpenAIResponsesOutputItem | undefined;
      if (typeof outputIndex === 'number' && item !== undefined) {
        closedItems.set(outputIndex, item);
      }
      continue;
    }

    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      const terminalResponse = rawEvent.response as OpenAIResponsesResult;
      if (closedItems.size > 0) {
        const output = [...closedItems].sort(([left], [right]) => left - right).map(([, item]) => item);
        return {
          ...terminalResponse,
          output,
        };
      }
      return terminalResponse;
    }
  }

  throw new Error('SSE stream ended without a terminal response event');
}
