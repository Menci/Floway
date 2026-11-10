import type { OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from './index.ts';

type OpenAIResponsesReassembleEvent =
  | OpenAIResponsesStreamEventEx
  | {
    type: 'error';
    message?: string;
  };

export async function reassembleOpenAIResponsesEvents(events: AsyncIterable<OpenAIResponsesReassembleEvent>): Promise<OpenAIResponsesResultEx> {
  for await (const event of events) {
    const rawEvent = event as unknown as Record<string, unknown>;
    const type = rawEvent.type as string;

    if (type === 'error') {
      const message = (rawEvent.message as string | undefined) ?? JSON.stringify(event);
      throw new Error(`Upstream SSE error: ${message}`);
    }

    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      return rawEvent.response as OpenAIResponsesResultEx;
    }
  }

  throw new Error('SSE stream ended without a terminal response event');
}
