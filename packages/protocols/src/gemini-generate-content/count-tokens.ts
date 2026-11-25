import { isJsonObject, type JsonObject } from '../common/json.ts';
import type { Result } from '@floway-dev/pipeline';

export type GeminiGenerateContentCountTokensResult = JsonObject & { totalTokens: number };

const isCountTokensResult = (body: unknown): body is GeminiGenerateContentCountTokensResult => isJsonObject(body)
  && typeof body.totalTokens === 'number' && Number.isSafeInteger(body.totalTokens) && body.totalTokens >= 0;

export const decodeGeminiGenerateContentCountTokensResult = (body: unknown): Result<GeminiGenerateContentCountTokensResult, Error> => isCountTokensResult(body)
  ? { ok: true, value: body }
  : { ok: false, error: new Error('Gemini countTokens response must contain a non-negative integer totalTokens') };
