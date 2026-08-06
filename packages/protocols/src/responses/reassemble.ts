import type { ResponsesResult, ResponsesStreamEvent } from './index.ts';

type ResponsesReassembleEvent =
  | ResponsesStreamEvent
  | {
    type: 'error';
    message?: string;
  };

export async function reassembleResponsesEvents(events: AsyncIterable<ResponsesReassembleEvent>): Promise<ResponsesResult> {
  let upstreamError: Error | undefined;
  for await (const event of events) {
    const rawEvent = event as unknown as Record<string, unknown>;
    const type = rawEvent.type as string;

    if (type === 'error') {
      const nested = rawEvent.error;
      const nestedMessage = typeof nested === 'object' && nested !== null
        ? (nested as { message?: unknown }).message
        : undefined;
      const message = (rawEvent.message as string | undefined)
        ?? (typeof nestedMessage === 'string' ? nestedMessage : undefined)
        ?? JSON.stringify(event);
      upstreamError = new Error(`Upstream SSE error: ${message}`);
      continue;
    }

    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      const response = rawEvent.response;
      if (typeof response !== 'object' || response === null || Array.isArray(response)) throw new TypeError(`${type} must carry a response object`);
      const expectedStatus = type === 'response.completed' ? 'completed' : type === 'response.incomplete' ? 'incomplete' : 'failed';
      const status = (response as { status?: unknown }).status;
      const completedCompaction = type === 'response.completed'
        && status === undefined
        && (response as { object?: unknown }).object === 'response.compaction';
      if (status !== expectedStatus && !completedCompaction) {
        throw new TypeError(`${type} cannot carry Responses status ${JSON.stringify(status)}`);
      }
      if (upstreamError !== undefined && type !== 'response.failed') throw upstreamError;
      return response as ResponsesResult;
    }
  }

  if (upstreamError !== undefined) throw upstreamError;
  throw new Error('SSE stream ended without a terminal response event');
}
