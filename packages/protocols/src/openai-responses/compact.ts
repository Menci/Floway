import type {
  CanonicalOpenAIResponsesPayload,
  OpenAIResponsesInputItem,
  OpenAIResponsesOutputItem,
  OpenAIResponsesPromptCacheOptions,
  OpenAIResponsesPromptCacheRetention,
  OpenAIResponsesResult,
} from './index.ts';
import type { OpenAIResponsesTransport } from '../common/index.ts';

// Narrower payload for `/responses/compact`. The official endpoint accepts a
// strict subset of `/responses` fields — model/input/instructions/
// previous_response_id/prompt_cache_*/service_tier — plus we honour `store`
// as a gateway-policy hint for snapshot persistence. Anything from
// `OpenAIResponsesPayload` not listed here (tools, temperature, max_output_tokens,
// reasoning, stream, etc.) is create-only and would be rejected or silently
// ignored by the upstream compact endpoint.
// Reference: https://developers.openai.com/api/reference/resources/responses/methods/compact
export interface OpenAIResponsesCompactPayload {
  model: string;
  input: string | OpenAIResponsesInputItem[];
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

export type CanonicalOpenAIResponsesCompactPayload = Omit<OpenAIResponsesCompactPayload, 'input'> & {
  input: OpenAIResponsesInputItem[];
};

// Project a (possibly-wider) ResponsesPayload-shaped object into the strict
// compact wire shape. Every native-compact provider terminal calls this
// before dispatching to its upstream's `/responses/compact` endpoint, so a
// post-chain action pivot that arrived carrying generate-only fields
// (tools/temperature/reasoning/...) cannot leak them onto the compact wire.
// `model` and `store` are caller-supplied at the dispatch site (model is
// the resolved upstream id; store is gateway-only).
export const toCompactPayloadShape = (
  payload: Omit<CanonicalOpenAIResponsesPayload, 'model'>,
  transport: OpenAIResponsesTransport = 'standard',
): Omit<CanonicalOpenAIResponsesCompactPayload, 'model' | 'store'> & Pick<CanonicalOpenAIResponsesPayload, 'reasoning' | 'parallel_tool_calls' | 'text'> => ({
  input: payload.input,
  ...(payload.instructions !== undefined && { instructions: payload.instructions }),
  ...(payload.previous_response_id !== undefined && { previous_response_id: payload.previous_response_id }),
  ...(payload.prompt_cache_key !== undefined && { prompt_cache_key: payload.prompt_cache_key }),
  ...(payload.prompt_cache_options !== undefined && { prompt_cache_options: payload.prompt_cache_options }),
  ...(payload.prompt_cache_retention !== undefined && { prompt_cache_retention: payload.prompt_cache_retention }),
  ...(payload.service_tier !== undefined && { service_tier: payload.service_tier }),
  // Codex's unary Lite compact request copies these controls from its Responses
  // request. Its transport test asserts the Lite header and reasoning/parallel
  // settings on `/responses/compact`; text is retained by CompactionInput.
  // https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/client.rs#L640-L674
  // https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/codex-api/src/common.rs#L46-L66
  // https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/tests/suite/responses_lite.rs#L546-L598
  ...(transport === 'lite' && payload.reasoning !== undefined && { reasoning: payload.reasoning }),
  ...(transport === 'lite' && payload.parallel_tool_calls !== undefined && { parallel_tool_calls: payload.parallel_tool_calls }),
  ...(transport === 'lite' && payload.text !== undefined && { text: payload.text }),
});

// The `/responses/compact` wire body: `CompactResource` states none of the
// response-only fields a `ResponseResource` requires — no `status`, `model`,
// `error` or `incomplete_details`.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L3935-L4008
//
// This models what an upstream sends, so `created_at` and `usage` stay optional
// even though the schema requires them; presence on the client-facing body is
// `ClientOpenAIResponsesCompaction`'s guarantee.
export interface OpenAIResponsesCompactionResult {
  id: string;
  object: string;
  output: OpenAIResponsesOutputItem[];
  created_at?: number;
  usage?: OpenAIResponsesResult['usage'];
}
