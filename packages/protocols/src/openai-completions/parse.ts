import type { CompletionsPayload, CompletionsResult } from './index.ts';
import { isJsonObject } from '../common/json.ts';

// The two boundaries where a `/v1/completions` body becomes a value. Both check what the
// gateway itself depends on and nothing beyond it: the request must name a model, because
// routing reads it, and either body must be a JSON object, because everything downstream
// addresses it as one. Which fields an upstream accepts and which it returns is the
// upstream's to decide, and a gateway opinion about the rest would have to be kept in step
// with every OpenAI-compatible implementation we route to.

export const parseCompletionsPayload = (value: unknown): CompletionsPayload => {
  if (!isJsonObject(value)) throw new Error('Completions request body must be an object.');
  if (typeof value.model !== 'string' || value.model.length === 0) {
    throw new Error('Completions request body must include a model string.');
  }
  return value as CompletionsPayload;
};

export const parseCompletionsResult = (value: unknown): CompletionsResult => {
  if (!isJsonObject(value)) throw new Error('Completions response body must be an object.');
  return value as CompletionsResult;
};
