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
export const toCompactPayloadShape = (payload: Omit<CanonicalOpenAIResponsesPayload, 'model'>): Omit<CanonicalOpenAIResponsesCompactPayload, 'model' | 'store'> => ({
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
