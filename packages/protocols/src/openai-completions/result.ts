import type { OpenAICompletionsChoice, OpenAICompletionsResult, OpenAICompletionsUsage } from './index.ts';
import { finiteJsonNumberValue, isJsonObject, isRawNumber, nonNegativeJsonInteger } from '../common/json.ts';
import type { Result } from '@floway-dev/pipeline';

const normalizeChoice = (choice: unknown): OpenAICompletionsChoice | undefined => {
  if (!isJsonObject(choice) || typeof choice.text !== 'string'
    || (choice.finish_reason !== null && typeof choice.finish_reason !== 'string')) return undefined;
  const index = nonNegativeJsonInteger(choice.index);
  if (index === undefined) return undefined;
  return { ...choice, index, text: choice.text, finish_reason: choice.finish_reason };
};

const normalizeUsage = (usage: unknown): OpenAICompletionsUsage | undefined => {
  if (!isJsonObject(usage)) return undefined;
  const promptTokens = nonNegativeJsonInteger(usage.prompt_tokens);
  const completionTokens = nonNegativeJsonInteger(usage.completion_tokens);
  const totalTokens = nonNegativeJsonInteger(usage.total_tokens);
  if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) return undefined;
  const normalized: OpenAICompletionsUsage = {
    ...usage, prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens,
  };
  const details = usage.prompt_tokens_details;
  if (details === undefined) return normalized;
  if (!isJsonObject(details) || isRawNumber(details)) return undefined;
  const cachedTokens = nonNegativeJsonInteger(details.cached_tokens);
  if (details.cached_tokens !== undefined && cachedTokens === undefined) return undefined;
  return {
    ...normalized,
    prompt_tokens_details: { ...details, ...(cachedTokens !== undefined && { cached_tokens: cachedTokens }) },
  };
};

const normalizeResult = (body: unknown): OpenAICompletionsResult | undefined => {
  if (!isJsonObject(body) || typeof body.id !== 'string' || body.object !== 'text_completion'
    || typeof body.model !== 'string' || !Array.isArray(body.choices)
    || (body.system_fingerprint !== undefined && typeof body.system_fingerprint !== 'string')) return undefined;
  const created = finiteJsonNumberValue(body.created);
  if (created === undefined) return undefined;
  const choices = body.choices.map(normalizeChoice);
  if (!choices.every(choice => choice !== undefined)) return undefined;
  const usage = body.usage === undefined ? undefined : normalizeUsage(body.usage);
  if (body.usage !== undefined && usage === undefined) return undefined;
  return {
    ...body, id: body.id, object: body.object, model: body.model, created, choices,
    ...(usage !== undefined && { usage }),
  };
};

export const decodeOpenAICompletionsResult = (body: unknown): Result<OpenAICompletionsResult, Error> => {
  const value = normalizeResult(body);
  return value === undefined
    ? { ok: false, error: new Error('Invalid OpenAI Completions result envelope, choices or usage') }
    : { ok: true, value };
};
