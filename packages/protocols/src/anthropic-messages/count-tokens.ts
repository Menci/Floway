import { isJsonObject, type JsonObject, nonNegativeJsonInteger } from '../common/json.ts';
import type { Result } from '@floway-dev/pipeline';

export type AnthropicMessagesCountTokensResult = JsonObject & { input_tokens: number };

export const decodeAnthropicMessagesCountTokensResult = (body: unknown): Result<AnthropicMessagesCountTokensResult, Error> => {
  if (isJsonObject(body)) {
    const inputTokens = nonNegativeJsonInteger(body.input_tokens);
    if (inputTokens !== undefined) return { ok: true, value: { ...body, input_tokens: inputTokens } };
  }
  return { ok: false, error: new Error('Anthropic Messages count_tokens response must contain a non-negative integer input_tokens') };
};
