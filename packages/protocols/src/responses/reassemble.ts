import type { ResponsesResult, ResponsesStreamEvent } from './index.ts';

type ResponsesReassembleEvent =
  | ResponsesStreamEvent
  | {
    type: 'error';
    message?: string;
  };

export async function reassembleResponsesEvents(events: AsyncIterable<ResponsesReassembleEvent>): Promise<ResponsesResult> {
  for await (const event of events) {
    const rawEvent = event as unknown as Record<string, unknown>;
    const type = rawEvent.type as string;

    if (type === 'error') {
      const message = (rawEvent.message as string | undefined) ?? JSON.stringify(event);
      throw new Error(`Upstream SSE error: ${message}`);
    }

    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      const response = rawEvent.response;
      if (typeof response !== 'object' || response === null || Array.isArray(response)) throw new TypeError(`${type} must carry a response object`);
      const expectedStatus = type === 'response.completed' ? 'completed' : type === 'response.incomplete' ? 'incomplete' : 'failed';
      if ((response as { status?: unknown }).status !== expectedStatus) {
        throw new TypeError(`${type} cannot carry Responses status ${JSON.stringify((response as { status?: unknown }).status)}`);
      }
      return response as ResponsesResult;
    }
  }

  throw new Error('SSE stream ended without a terminal response event');
}
