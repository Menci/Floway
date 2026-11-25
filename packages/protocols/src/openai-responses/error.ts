import type { OpenAIErrorFields } from '../common/openai-error.ts';

// https://developers.openai.com/api/reference/resources/responses/streaming-events#error
export const formatOpenAIResponsesError = (
  _status: number | null,
  message: string,
  fields?: Omit<OpenAIErrorFields, 'type'>,
) => ({ type: 'error', message, ...fields } as const);
