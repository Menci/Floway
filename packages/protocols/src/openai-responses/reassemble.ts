import type { OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from './index.ts';

export const OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE = 'OpenAI Responses stream ended without a terminal event.';

export async function reassembleOpenAIResponsesEvents(events: AsyncIterable<OpenAIResponsesStreamEventEx>): Promise<OpenAIResponsesResultEx> {
  let error: Extract<OpenAIResponsesStreamEventEx, { type: 'error' }> | undefined;
  for await (const event of events) {
    if (event.type === 'error') {
      error = event;
    }

    if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      if (event.type === 'response.failed' && error !== undefined) throw new Error(errorMessage(error), { cause: error });
      return event.response;
    }
  }

  if (error !== undefined) throw new Error(errorMessage(error), { cause: error });
  throw new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE);
}

const errorMessage = (error: Extract<OpenAIResponsesStreamEventEx, { type: 'error' }>): string =>
  'message' in error ? error.message : error.error.message;
