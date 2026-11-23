import type { InputErrorDetails } from '../shared/errors.ts';

export class ResponsesInputError extends Error {
  constructor(readonly details: InputErrorDetails) {
    super(details.message);
    this.name = 'ResponsesInputError';
  }
}

export const responsesInputErrorBody = (error: InputErrorDetails) => ({
  error: { message: error.message, type: 'invalid_request_error', param: error.param ?? 'input', code: error.code ?? null },
});
