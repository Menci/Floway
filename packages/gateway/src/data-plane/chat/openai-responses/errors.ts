import type { InputErrorDetails } from '../shared/errors.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import type { ProtocolError } from '@floway-dev/provider';

export const openAIResponsesLocalError = (
  status: number,
  message: string,
  fields: { type?: string; param?: string | null; code?: string | null } = {},
): { http: HttpResponseFact; outcome: ProtocolError } => ({
  http: { status, statusText: '', headers: [['content-type', 'application/json']], body: null },
  outcome: { kind: 'error', source: 'local', error: { error: { message, type: 'invalid_request_error', ...fields } } },
});

export const openAIResponsesInputError = (error: InputErrorDetails) => {
  const { http, outcome } = openAIResponsesLocalError(400, error.message, { param: error.param ?? 'input', code: error.code ?? null });
  return { 'response.http': http, 'response.openaiResponses': outcome };
};
