import type { OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from './index.ts';

export const isOpenAIResponsesTerminalEvent = (event: Pick<OpenAIResponsesStreamEventEx, 'type'>): boolean =>
  event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed' || event.type === 'error';

// Typed accessor for the `response` payload carried on lifecycle envelopes
// (`response.queued`, `response.created`, `response.in_progress`, `response.completed`,
// `response.incomplete`, `response.failed`). Returns null on every other
// event type so callers don't have to reproduce the variant check.
export const openaiResponsesResultFromStreamEvent = (event: OpenAIResponsesStreamEventEx): OpenAIResponsesResultEx | null =>
  'response' in event ? event.response : null;
