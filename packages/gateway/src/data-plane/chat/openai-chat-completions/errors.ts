import type { InputErrorDetails } from '../shared/errors.ts';

export const openaiChatCompletionsInputError = (error: InputErrorDetails) => ({
  error: { message: error.message, type: 'invalid_request_error', param: error.param ?? 'messages', code: null },
});
