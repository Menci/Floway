import type { InputErrorDetails } from '../shared/errors.ts';

export const responsesInputErrorBody = (error: InputErrorDetails) => ({
  error: { message: error.message, type: 'invalid_request_error', param: error.param ?? 'input', code: error.code ?? null },
});
