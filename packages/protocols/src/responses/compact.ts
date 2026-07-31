import type {
  CanonicalResponsesPayload,
  ResponsesInputItem,
  ResponsesOutputItem,
  ResponsesPromptCacheOptions,
  ResponsesPromptCacheRetention,
  ResponsesResult,
} from './index.ts';

// Narrower payload for `/responses/compact`. The official endpoint accepts a
// strict subset of `/responses` fields — model/input/instructions/
// previous_response_id/prompt_cache_*/service_tier — plus we honour `store`
// as a gateway-policy hint for snapshot persistence. Anything from
// `ResponsesPayload` not listed here (tools, temperature, max_output_tokens,
// reasoning, stream, etc.) is create-only and would be rejected or silently
// ignored by the upstream compact endpoint.
// Reference: https://developers.openai.com/api/reference/resources/responses/methods/compact
export interface ResponsesCompactPayload {
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string | null;
  previous_response_id?: string | null;
  prompt_cache_key?: string | null;
  prompt_cache_options?: ResponsesPromptCacheOptions | null;
  prompt_cache_retention?: ResponsesPromptCacheRetention | null;
  service_tier?: 'default' | 'auto' | 'flex' | 'priority' | 'scale' | (string & {}) | null;
  // Gateway-only: controls whether the compact response's output items + the
  // committed snapshot persist. Forwarded NEITHER to upstream nor to the
  // provider call body.
  store?: boolean | null;
}

export type CanonicalResponsesCompactPayload = Omit<ResponsesCompactPayload, 'input'> & {
  input: ResponsesInputItem[];
};

// Project a (possibly-wider) ResponsesPayload-shaped object into the strict
// compact wire shape. Every native-compact provider terminal calls this
// before dispatching to its upstream's `/responses/compact` endpoint, so a
// post-chain action pivot that arrived carrying generate-only fields
// (tools/temperature/reasoning/...) cannot leak them onto the compact wire.
// `model` and `store` are caller-supplied at the dispatch site (model is
// the resolved upstream id; store is gateway-only).
export const toCompactPayloadShape = (payload: Omit<CanonicalResponsesPayload, 'model'>): Omit<CanonicalResponsesCompactPayload, 'model' | 'store'> => ({
  input: payload.input,
  ...(payload.instructions !== undefined && { instructions: payload.instructions }),
  ...(payload.previous_response_id !== undefined && { previous_response_id: payload.previous_response_id }),
  ...(payload.prompt_cache_key !== undefined && { prompt_cache_key: payload.prompt_cache_key }),
  ...(payload.prompt_cache_options !== undefined && { prompt_cache_options: payload.prompt_cache_options }),
  ...(payload.prompt_cache_retention !== undefined && { prompt_cache_retention: payload.prompt_cache_retention }),
  ...(payload.service_tier !== undefined && { service_tier: payload.service_tier }),
});

// The `/responses/compact` wire body: `CompactResource` states none of the
// response-only fields a `ResponseResource` requires — no `status`, `model`,
// `error` or `incomplete_details`.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L3935-L4008
//
// This models what an upstream sends, so `created_at` and `usage` stay optional
// even though the schema requires them; presence on the client-facing body is
// `ClientResponsesCompaction`'s guarantee.
export interface ResponsesCompactionResult {
  id: string;
  object: string;
  output: ResponsesOutputItem[];
  created_at?: number;
  usage?: ResponsesResult['usage'];
}
