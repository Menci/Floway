import type { OpenAICompletionsChoice, OpenAICompletionsResult, OpenAICompletionsUsage } from './index.ts';
import { isJsonObject } from '../common/json.ts';
import type { Result } from '@floway-dev/pipeline';

const tokenCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isChoice = (choice: unknown): choice is OpenAICompletionsChoice => isJsonObject(choice)
  && tokenCount(choice.index) && typeof choice.text === 'string'
  && (choice.finish_reason === null || typeof choice.finish_reason === 'string');

const isUsage = (usage: unknown): usage is OpenAICompletionsUsage => {
  if (!isJsonObject(usage) || !tokenCount(usage.prompt_tokens) || !tokenCount(usage.completion_tokens) || !tokenCount(usage.total_tokens)) return false;
  const details = usage.prompt_tokens_details;
  return details === undefined || (isJsonObject(details) && (details.cached_tokens === undefined || tokenCount(details.cached_tokens)));
};

const isResult = (body: unknown): body is OpenAICompletionsResult => isJsonObject(body)
  && typeof body.id === 'string' && body.object === 'text_completion'
  && typeof body.created === 'number' && Number.isFinite(body.created) && typeof body.model === 'string'
  && Array.isArray(body.choices) && body.choices.every(isChoice)
  && (body.usage === undefined || isUsage(body.usage))
  && (body.system_fingerprint === undefined || typeof body.system_fingerprint === 'string');

export const decodeOpenAICompletionsResult = (body: unknown): Result<OpenAICompletionsResult, Error> => isResult(body)
  ? { ok: true, value: body }
  : { ok: false, error: new Error('Invalid OpenAI Completions result envelope, choices or usage') };
