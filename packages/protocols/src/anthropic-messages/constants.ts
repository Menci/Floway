/**
 * Anthropic Messages requires `max_tokens`, but translated source protocols
 * and Claude Code-shaped clients may omit their output-token cap. Whenever
 * Floway must synthesize one, the data-plane prefers the model's advertised
 * `/models` output cap (`limits.max_output_tokens`); this constant is the
 * last-resort gateway policy when both the payload and model capability are
 * silent. The Playground uses the same value for its initial request budget.
 *
 * There is no single ecosystem standard catch-all value here: `new-api`
 * defaults Claude to `8192`, while `one-api` and LiteLLM use `4096`. Those
 * conservative values can stop modern Claude generations prematurely, so
 * Floway uses `32768`; this is a gateway policy, not an upstream default.
 * Explicit client values are preserved. Claude Code subscription requests
 * that omit the required field are completed from this policy so they reach
 * the upstream with a usable output budget.
 *
 * References:
 * - https://github.com/BerriAI/litellm/blob/e9e86ed956ba53d5192e10b75634fe0246e836a7/litellm/llms/anthropic/chat/transformation.py
 * - https://github.com/QuantumNous/new-api/blob/65b16547329625f619cf797ae1eb9b748525056c/setting/model_setting/claude.go
 * - https://github.com/songquanpeng/one-api/blob/8df4a2670b98266bd287c698243fff327d9748cf/relay/adaptor/anthropic/main.go
 */
export const ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS = 32768;

// https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts
export const ANTHROPIC_MESSAGES_WEB_SEARCH_ERROR_CODES = ['too_many_requests', 'invalid_tool_input', 'max_uses_exceeded', 'query_too_long', 'request_too_large', 'unavailable'] as const;
