import { jsonHttpResponse } from '../../pipeline/edge-http.ts';
import type { InputErrorDetails } from '../shared/errors.ts';
import type { ChatBodyOutput } from '../shared/route-body.ts';
import type { Scope } from '@floway-dev/pipeline';

export class ResponsesInputError extends Error {
  constructor(readonly details: InputErrorDetails) {
    super(details.message);
    this.name = 'ResponsesInputError';
  }
}

export const responsesInputErrorBody = (error: InputErrorDetails) => ({
  error: { message: error.message, type: 'invalid_request_error', param: error.param ?? 'input', code: error.code ?? null },
});
export const localResponsesError = (scope: Pick<Scope, 'clock'>, status: number, error: {
  readonly error: {
    readonly message: string;
    readonly type: string;
    readonly param?: string | null;
    readonly code?: string | null;
  };
}): ChatBodyOutput<'openaiResponses'> => ({
  'response.http': jsonHttpResponse(status, error, scope.clock()),
  'response.openaiResponses': { kind: 'error', source: 'local', error },
});
