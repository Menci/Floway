import type { IRErrorPayload } from '../../../ir/output/error.ts';
import { errorDetailsOf } from '../../../shared/api-error.ts';

export const openaiChatCompletionsErrorFromIR = (error: IRErrorPayload) => {
  const details = errorDetailsOf(error, ['message', 'type', 'code', 'param']);
  return {
    message: error.message,
    ...(error.type === undefined ? {} : { type: error.type }),
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.param === undefined ? {} : { param: error.param }),
    ...(details === undefined ? {} : { provider_specific_fields: details }),
  };
};
