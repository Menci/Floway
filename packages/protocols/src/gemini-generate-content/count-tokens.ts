import { isJsonObject, type JsonObject, nonNegativeJsonInteger } from '../common/json.ts';
import type { Result } from '@floway-dev/pipeline';

export type GeminiGenerateContentCountTokensResult = JsonObject & { totalTokens: number };

export const decodeGeminiGenerateContentCountTokensResult = (body: unknown): Result<GeminiGenerateContentCountTokensResult, Error> => {
  if (isJsonObject(body)) {
    const totalTokens = nonNegativeJsonInteger(body.totalTokens);
    if (totalTokens !== undefined) return { ok: true, value: { ...body, totalTokens } };
  }
  return { ok: false, error: new Error('Gemini countTokens response must contain a non-negative integer totalTokens') };
};
