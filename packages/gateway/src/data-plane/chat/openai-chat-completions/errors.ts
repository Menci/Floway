import type { InputErrorDetails } from '../shared/errors.ts';
import type { OpenAIChatCompletionsErrorEvent } from '@floway-dev/protocols/openai-chat-completions';
import { internalDebugErrorFields, toInternalDebugError } from '@floway-dev/provider';

/** A gateway fault, with its diagnostics under the provider-extension field. A stream that
 *  fails carries the same object as its last event. */
export const internalOpenAIChatCompletionsError = (error: unknown): OpenAIChatCompletionsErrorEvent => {
  const debug = toInternalDebugError(error, 'openaiChatCompletions');
  return { error: { type: debug.type, message: debug.message, provider_specific_fields: internalDebugErrorFields(debug) } };
};

/** Caller input the selected target cannot carry, in this protocol's 400 envelope. */
export const openaiChatCompletionsInputError = (error: InputErrorDetails): Record<string, unknown> => ({
  error: { message: error.message, type: 'invalid_request_error', param: error.param ?? 'messages', code: error.code ?? null },
});
