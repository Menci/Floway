import type { OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from './index.ts';

// Streaming errors are followed by the failed response resource.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L419-L444
export const isOpenAIResponsesTerminalEvent = (event: Pick<OpenAIResponsesStreamEventEx, 'type'>): boolean =>
  event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed';

export const isOpenAIResponsesErrorEvent = (value: unknown): value is Extract<OpenAIResponsesStreamEventEx, { type: 'error' }> => {
  if (value === null || typeof value !== 'object' || !('type' in value) || value.type !== 'error') return false;
  return ('message' in value && typeof value.message === 'string')
    || ('error' in value && value.error !== null && typeof value.error === 'object' && 'message' in value.error && typeof value.error.message === 'string');
};

// Typed accessor for the `response` payload carried on lifecycle envelopes
// (`response.queued`, `response.created`, `response.in_progress`, `response.completed`,
// `response.incomplete`, `response.failed`). Returns null on every other
// event type so callers don't have to reproduce the variant check.
export const openaiResponsesResultFromStreamEvent = (event: OpenAIResponsesStreamEventEx): OpenAIResponsesResultEx | null =>
  'response' in event ? event.response : null;
