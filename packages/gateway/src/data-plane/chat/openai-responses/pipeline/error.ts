import { responseHead } from '../../../pipeline/response.ts';
import type { InputErrorDetails } from '../../shared/errors.ts';
import { move } from '@floway-dev/pipeline';

export const openAIResponsesInputErrorBody = ({ message, param = 'input', code }: InputErrorDetails) =>
  ({ error: { message, type: 'invalid_request_error', param, code: code ?? null } });

export const openAIResponsesError = (status: number, error: unknown) => ({
  'response.http': move(responseHead(status)),
  'response.openaiResponses': move({ kind: 'error', source: 'local', error } as const),
});

export const openAIResponsesInputError = (details: InputErrorDetails) =>
  openAIResponsesError(400, openAIResponsesInputErrorBody(details));
