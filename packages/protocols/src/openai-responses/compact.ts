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
import { isJsonObject } from '../common/json.ts';
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

// Project a (possibly-wider) ResponsesPayload-shaped object into the strict
// compact wire shape. Every native-compact provider terminal calls this
// before dispatching to its upstream's `/responses/compact` endpoint, so a
// post-chain action pivot that arrived carrying generate-only fields
// (tools/temperature/reasoning/...) cannot leak them onto the compact wire.
// `model` and `store` are caller-supplied at the dispatch site (model is
// the resolved upstream id; store is gateway-only).
export const toCompactPayloadShape = (
  payload: Omit<CanonicalOpenAIResponsesPayload, 'model'> | CanonicalOpenAIResponsesCompactPayload,
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

const tokenCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isCompactionUsage = (usage: unknown): usage is NonNullable<OpenAIResponsesCompactionResultEx['usage']> => {
  if (!isJsonObject(usage) || !tokenCount(usage.input_tokens) || !tokenCount(usage.output_tokens) || !tokenCount(usage.total_tokens)) return false;
  const input = usage.input_tokens_details;
  const output = usage.output_tokens_details;
  return (input === undefined || (isJsonObject(input) && tokenCount(input.cached_tokens)
    && (input.cache_write_tokens === undefined || tokenCount(input.cache_write_tokens))))
    && (output === undefined || (isJsonObject(output) && tokenCount(output.reasoning_tokens)));
};

const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';
const optionalNullableString = (value: unknown): boolean => value === null || optionalString(value);
const isRecordList = (value: unknown): value is Record<string, unknown>[] => Array.isArray(value) && value.every(isJsonObject);

const isInputPart = (part: unknown): boolean => {
  if (!isJsonObject(part)) return false;
  switch (part.type) {
  case 'input_text':
  case 'output_text': return typeof part.text === 'string';
  case 'input_image': return optionalNullableString(part.detail) && optionalNullableString(part.file_id) && optionalNullableString(part.image_url);
  case 'input_file': return optionalNullableString(part.file_id) && optionalNullableString(part.file_url)
    && optionalNullableString(part.file_data) && optionalNullableString(part.filename);
  case 'input_audio': return (typeof part.audio_url === 'string' && part.file_id === undefined)
    || (typeof part.file_id === 'string' && part.audio_url === undefined);
  default: return false;
  }
};

const isInputContent = (content: unknown): boolean => typeof content === 'string' || (Array.isArray(content) && content.every(isInputPart));

const isMessage = (item: Record<string, unknown>): boolean => {
  const { role, content } = item;
  if ((role !== 'user' && role !== 'system' && role !== 'developer' && role !== 'assistant')
    || !optionalString(item.id) || !optionalString(item.status) || !optionalNullableString(item.phase)) return false;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.every(part =>
    isInputPart(part) || (role === 'assistant' && isJsonObject(part) && part.type === 'refusal' && typeof part.refusal === 'string'));
};

const isStoredItem = (item: unknown): item is OpenAIResponsesStoredItem => {
  if (!isJsonObject(item) || typeof item.type !== 'string') return false;
  switch (item.type) {
  case 'message':
    return isMessage(item);
  case 'compaction':
  case 'compaction_summary':
  case 'context_compaction':
    return optionalNullableString(item.id) && optionalNullableString(item.encrypted_content) && optionalString(item.created_by);
  case 'reasoning':
    return optionalNullableString(item.id) && isRecordList(item.summary) && item.summary.every(part => part.type === 'summary_text' && typeof part.text === 'string')
      && (item.content === undefined || (isRecordList(item.content) && item.content.every(part => part.type === 'reasoning_text' && typeof part.text === 'string')))
      && optionalNullableString(item.encrypted_content);
  case 'function_call':
    return optionalString(item.id) && optionalString(item.status)
      && typeof item.call_id === 'string' && typeof item.name === 'string' && typeof item.arguments === 'string';
  case 'function_call_output':
    return optionalNullableString(item.id) && isInputContent(item.output) && optionalString(item.call_id);
  default:
    return true;
  }
};

const isCompactionResult = (body: unknown): body is OpenAIResponsesCompactionResultEx => isJsonObject(body)
  && typeof body.id === 'string' && typeof body.object === 'string'
  && Array.isArray(body.output) && body.output.every(isStoredItem)
  && (body.created_at === undefined || (typeof body.created_at === 'number' && Number.isFinite(body.created_at)))
  && (body.usage === undefined || body.usage === null || isCompactionUsage(body.usage));

export const decodeOpenAIResponsesCompactionResult = (body: unknown): Result<OpenAIResponsesCompactionResultEx, Error> => isCompactionResult(body)
  ? { ok: true, value: body }
  : { ok: false, error: new Error('Invalid OpenAI Responses compaction result envelope, output items or usage') };
