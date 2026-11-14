import type { ChatServeFailure, InputErrorDetails } from '../shared/errors.ts';
import { isJsonObject } from '@floway-dev/protocols/common';
import type { OpenAIResponsesErrorEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { internalDebugErrorFields, toInternalDebugError } from '@floway-dev/provider';

/** The chat-wide refusals plus the one only this protocol can make: a turn that named an item
 *  by id which the store cannot resolve. It is thrown from inside the membrane's hydration
 *  rather than returned, because hydration walks the input and the item that is missing is
 *  found several frames below where the answer is written. */
export type OpenAIResponsesServeFailure = ChatServeFailure | { readonly kind: 'item-not-found'; readonly itemId: string };

/** A gateway fault answered as JSON, with its diagnostics under the provider-extension field. */
export const internalErrorEnvelope = (error: unknown) => {
  const debug = toInternalDebugError(error);
  return { error: { type: debug.type, message: debug.message, provider_specific_fields: internalDebugErrorFields(debug) } };
};

/** The same fault as the error object a stream carries, in its `error` event and on the
 *  `response.failed` resource that follows it. */
export const internalStreamFailure = (error: unknown): OpenAIResponsesErrorEx => {
  const debug = toInternalDebugError(error);
  return { code: debug.type, message: debug.message, provider_specific_fields: internalDebugErrorFields(debug) };
};

/** Caller input the selected target cannot carry, in this protocol's 400 envelope. */
export const inputErrorEnvelope = (error: InputErrorDetails): Record<string, unknown> => ({
  error: { message: error.message, type: 'invalid_request_error', param: error.param ?? 'input', code: error.code ?? null },
});

const ERROR_HTTP_STATUS = new Map<string, number>([
  ['invalid_request_error', 400],
  ['invalid_prompt', 400],
  ['authentication_error', 401],
  ['invalid_api_key', 401],
  ['permission_error', 403],
  ['not_found_error', 404],
  ['conflict_error', 409],
  ['unprocessable_entity_error', 422],
  ['rate_limit_error', 429],
  ['rate_limit_exceeded', 429],
  ['insufficient_quota', 429],
  ['server_error', 500],
  ['internal_error', 500],
]);

/** The HTTP status a stream's `error` event stands for, when a client that did not stream is
 *  answered with that event: OpenAI SDKs classify API failures by these HTTP categories.
 *  https://github.com/openai/openai-node/blob/b579bcb3e586d22269ffe6fe504653a0e05acbe8/src/core/error.ts#L60-L94 */
export const openaiResponsesErrorHttpStatus = (event: Extract<OpenAIResponsesStreamEventEx, { type: 'error' }>): number => {
  const { type: _type, sequence_number: _sequenceNumber, ...fields } = event;
  const payload = ('error' in fields && isJsonObject(fields.error) ? fields.error : fields) as Readonly<Record<string, unknown>>;
  const details = isJsonObject(payload.provider_specific_fields) ? payload.provider_specific_fields : undefined;
  for (const classification of [payload.code, payload.type, details?.code, details?.type]) {
    if (typeof classification !== 'string') continue;
    const status = ERROR_HTTP_STATUS.get(classification);
    if (status !== undefined) return status;
  }
  return 502;
};
