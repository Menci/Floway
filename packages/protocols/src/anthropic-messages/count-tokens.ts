import { isJsonObject, type JsonObject } from '../common/json.ts';
import type { Result } from '@floway-dev/pipeline';

export type AnthropicMessagesCountTokensResult = JsonObject & { input_tokens: number };

const isCountTokensResult = (body: unknown): body is AnthropicMessagesCountTokensResult => isJsonObject(body)
  && typeof body.input_tokens === 'number' && Number.isSafeInteger(body.input_tokens) && body.input_tokens >= 0;

export const decodeAnthropicMessagesCountTokensResult = (body: unknown): Result<AnthropicMessagesCountTokensResult, Error> => isCountTokensResult(body)
  ? { ok: true, value: body }
  : { ok: false, error: new Error('Anthropic Messages count_tokens response must contain a non-negative integer input_tokens') };
