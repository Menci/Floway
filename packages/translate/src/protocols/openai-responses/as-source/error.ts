import type { IRErrorPayload } from '../../../ir/types.ts';
import { errorDetailsOf } from '../../../shared/api-error.ts';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const openaiResponsesErrorEventOf = (error: IRErrorPayload): OpenAIResponsesStreamEventEx => {
  const details = errorDetailsOf(error, ['message', 'code', 'param']);
  return {
    type: 'error',
    message: error.message,
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.param === undefined ? {} : { param: error.param }),
    ...(details === undefined ? {} : { provider_specific_fields: details }),
  };
};
