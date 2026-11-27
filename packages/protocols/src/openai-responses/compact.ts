import type {
  CanonicalOpenAIResponsesPayload,
  OpenAIResponsesCompactionItem,
  CanonicalOpenAIResponsesInputItem,
  OpenAIResponsesOutputItemEx,
  OpenAIResponsesRequestInputItem,
  OpenAIResponsesPromptCacheOptions,
  OpenAIResponsesPromptCacheRetention,
  OpenAIResponsesResultEx,
} from './index.ts';
import { finiteJsonNumberValue, isJsonObject, nonNegativeJsonInteger } from '../common/json.ts';
import type { Result } from '@floway-dev/pipeline';

export interface OpenAIResponsesCompactPayloadEx {
  model: string;
  input?: string | OpenAIResponsesRequestInputItem[] | null;
  instructions?: string | null;
  previous_response_id?: string | null;
  prompt_cache_key?: string | null;
  prompt_cache_options?: OpenAIResponsesPromptCacheOptions | null;
  prompt_cache_retention?: OpenAIResponsesPromptCacheRetention | null;
  service_tier?: 'default' | 'auto' | 'flex' | 'priority' | 'scale' | (string & {}) | null;
  // Gateway-only: controls whether the compact response's output items + the
  // committed snapshot persist. Forwarded NEITHER to upstream nor to the
  // provider call body.
  store?: boolean | null;
}

export type CanonicalOpenAIResponsesCompactPayload = Omit<OpenAIResponsesCompactPayloadEx, 'input'> & {
  input: CanonicalOpenAIResponsesInputItem[];
};

// A generation request can pivot to compact while still carrying generation
// options. Send only compact wire fields. The upstream selects `model` at
// dispatch and the gateway handles `store`.
export const toCompactPayloadShape = (
  payload: Omit<CanonicalOpenAIResponsesPayload, 'model'> | Omit<CanonicalOpenAIResponsesCompactPayload, 'model'>,
): Omit<CanonicalOpenAIResponsesCompactPayload, 'model' | 'store'> => ({
  input: payload.input,
  ...(payload.instructions !== undefined && { instructions: payload.instructions }),
  ...(payload.previous_response_id !== undefined && { previous_response_id: payload.previous_response_id }),
  ...(payload.prompt_cache_key !== undefined && { prompt_cache_key: payload.prompt_cache_key }),
  ...(payload.prompt_cache_options !== undefined && { prompt_cache_options: payload.prompt_cache_options }),
  ...(payload.prompt_cache_retention !== undefined && { prompt_cache_retention: payload.prompt_cache_retention }),
  ...(payload.service_tier !== undefined && { service_tier: payload.service_tier }),
});

export type OpenAIResponsesStoredItem = CanonicalOpenAIResponsesInputItem | OpenAIResponsesOutputItemEx;

// The `/responses/compact` wire body: `CompactResource` states none of the
// response-only fields a `ResponseResource` requires — no `status`, `model`,
// `error` or `incomplete_details`.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L3935-L4008
//
// This models what an upstream sends, so `created_at` and `usage` stay optional
// even though the schema requires them; presence on the client-facing body is
// `ClientOpenAIResponsesCompaction`'s guarantee.
export interface OpenAIResponsesCompactionResultEx {
  id: string;
  object: string;
  output: OpenAIResponsesStoredItem[];
  created_at?: number;
  usage?: OpenAIResponsesResultEx['usage'];
}

export const isOpenAIResponsesCompactionItem = (item: { type: string }): item is OpenAIResponsesCompactionItem =>
  item.type === 'compaction' || item.type === 'compaction_summary' || item.type === 'context_compaction';

const normalizeCompactionUsage = (usage: unknown): NonNullable<OpenAIResponsesCompactionResultEx['usage']> | undefined => {
  if (!isJsonObject(usage)) return undefined;
  const inputTokens = nonNegativeJsonInteger(usage.input_tokens);
  const outputTokens = nonNegativeJsonInteger(usage.output_tokens);
  const totalTokens = nonNegativeJsonInteger(usage.total_tokens);
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) return undefined;
  const normalized: NonNullable<OpenAIResponsesCompactionResultEx['usage']> = {
    ...usage, input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens,
  };
  const input = usage.input_tokens_details;
  if (input !== undefined) {
    if (!isJsonObject(input)) return undefined;
    const cachedTokens = nonNegativeJsonInteger(input.cached_tokens);
    const cacheWriteTokens = nonNegativeJsonInteger(input.cache_write_tokens);
    if (cachedTokens === undefined || (input.cache_write_tokens !== undefined && cacheWriteTokens === undefined)) return undefined;
    normalized.input_tokens_details = {
      ...input, cached_tokens: cachedTokens,
      ...(cacheWriteTokens !== undefined && { cache_write_tokens: cacheWriteTokens }),
    };
  }
  const output = usage.output_tokens_details;
  if (output !== undefined) {
    if (!isJsonObject(output)) return undefined;
    const reasoningTokens = nonNegativeJsonInteger(output.reasoning_tokens);
    if (reasoningTokens === undefined) return undefined;
    normalized.output_tokens_details = { ...output, reasoning_tokens: reasoningTokens };
  }
  return normalized;
};

const normalizeCompactionResult = (body: unknown): OpenAIResponsesCompactionResultEx | undefined => {
  if (!isJsonObject(body) || typeof body.id !== 'string' || typeof body.object !== 'string'
    || !Array.isArray(body.output) || !body.output.every(item => isJsonObject(item) && typeof item.type === 'string')) return undefined;
  const createdAt = finiteJsonNumberValue(body.created_at);
  if (body.created_at !== undefined && createdAt === undefined) return undefined;
  const usage = body.usage == null ? body.usage : normalizeCompactionUsage(body.usage);
  if (body.usage !== undefined && usage === undefined) return undefined;
  return {
    ...body, id: body.id, object: body.object, output: body.output,
    ...(createdAt !== undefined && { created_at: createdAt }),
    ...(usage !== undefined && { usage }),
  };
};

export const decodeOpenAIResponsesCompactionResult = (body: unknown): Result<OpenAIResponsesCompactionResultEx, Error> => {
  const value = normalizeCompactionResult(body);
  return value === undefined
    ? { ok: false, error: new Error('Invalid OpenAI Responses compaction result envelope, output items or usage') }
    : { ok: true, value };
};
