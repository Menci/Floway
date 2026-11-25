import type { IRErrorPayload } from '../../../ir/output/error.ts';
import { errorDetailsOf } from '../../../shared/api-error.ts';
import { formatOpenAIChatCompletionsError } from '@floway-dev/protocols/openai-chat-completions';

export const openaiChatCompletionsErrorFromIR = (error: IRErrorPayload) => {
  const details = errorDetailsOf(error, ['message', 'type', 'code', 'param']);
  return formatOpenAIChatCompletionsError(null, error.message, {
    ...(error.type === undefined ? {} : { type: error.type }),
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.param === undefined ? {} : { param: error.param }),
    ...(details === undefined ? {} : { provider_specific_fields: details }),
  });
};
