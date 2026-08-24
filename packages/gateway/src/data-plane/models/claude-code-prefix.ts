// The Claude Code model picker (enabled by the
// `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` env var) applies two
// filters to the `/v1/models` payload before populating its `/model`
// menu. Anthropic documents both filters at
// https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery:
//
//   > Claude Code reads `id` and the optional `display_name` from each
//   > entry in the response's `data` array. It keeps an entry when its
//   > `id` contains `claude` or `anthropic` anywhere in the string,
//   > matched case-insensitively, and ignores the rest.
//
//   > A discovered ID is skipped when it exactly matches a row already
//   > in the picker, or when both the discovered and existing IDs
//   > resolve to Fable.
//
// The id filter was loosened in Claude Code v2.1.223: before that release
// the picker only kept ids that *began* with `claude` or `anthropic`
// (`/^(claude|anthropic)/i`), which hid provider-prefixed ids such as
// `vertex_ai/claude-sonnet-4-6`. The encoder here keeps the stricter
// begins-with predicate so a single encoding survives both picker
// generations — an id the new picker admits only by the contains-anywhere
// rule still gets the prefix, and `claude-code!` begins with `claude`, so
// the prefixed form also passes the old begins-with filter. Extracted
// from the compiled `Bootstrap Gateway /v1/models` handler in
// `@anthropic-ai/claude-code@2.1.211` (captured 2026-07-16 by grepping
// the Bun-compiled darwin-arm64 binary around the `[Bootstrap] Gateway
// /v1/models` telemetry strings); the docs are the primary
// source-of-truth and pin the `fable5` carve-out and evaluation order the
// prose leaves implicit.
//
// Consequences for gateway callers:
//
//  - `label: display_name ?? id` — the picker renders `display_name` to
//    the user; the id itself is only shown on the wire. Rewriting the
//    id is invisible in the UI.
//  - `claude-code!` passes the id filter and never exact-matches a
//    built-in family string, so prefixed non-Anthropic ids survive both
//    filters without masquerading as an upstream-native Claude family.
//  - The prefix is an encoding marker, not a reserved model-id namespace.
//    Floway model ids are opaque, so discovery also prefixes a raw id that
//    already begins with the marker. This prefix-doubling makes the mapping
//    injective: M, P+M, and P+P+M become P+M, P+P+M, and P+P+P+M.
export const CLAUDE_CODE_SYNTHETIC_PREFIX = 'claude-code!';

// Ids the picker admits without a prefix. Uses the stricter begins-with
// form (the pre-v2.1.223 filter) rather than the current contains-anywhere
// rule so one encoding survives both picker generations — see the header
// comment. Kept next to the encoder so the accept and escape decisions
// cannot drift apart.
export const CLAUDE_CODE_PICKER_ID_ACCEPT = /^(claude|anthropic)/i;

export const encodeClaudeCodeModelId = (modelId: string): string =>
  CLAUDE_CODE_PICKER_ID_ACCEPT.test(modelId)
  && !modelId.startsWith(CLAUDE_CODE_SYNTHETIC_PREFIX)
    ? modelId
    : `${CLAUDE_CODE_SYNTHETIC_PREFIX}${modelId}`;

// The Claude Desktop app embeds the same Claude Code picker the standalone
// CLI serves, but its HTTP layer is an Electron browser fetch. Both its
// `/v1/models` discovery and its `/v1/messages` inference therefore carry
// the desktop app's `Mozilla/5.0 … Claude/<version> … Electron/…`
// User-Agent instead of the CLI's `claude-code/<version>` (discovery) or
// `claude-cli/<version>` (inference) tokens. The `Claude/<version>`
// product token (capital C, no hyphen) is the stable desktop-app signal;
// neither CLI token contains it, and no Anthropic SDK does either. The
// shared `.*\bClaude\/\d` alternative below admits that desktop UA on
// both the discovery and inference paths.
const CLAUDE_CODE_DISCOVERY_USER_AGENT = /^(?:claude-code\/|.*\bClaude\/\d)/;

export const isClaudeCodeDiscoveryUserAgent = (userAgent: string | undefined): boolean =>
  userAgent !== undefined && CLAUDE_CODE_DISCOVERY_USER_AGENT.test(userAgent);

// Claude Code inference requests use the Anthropic SDK's `claude-cli/*`
// User-Agent rather than the `claude-code/*` discovery identity; the
// Claude Desktop app reuses the picker but sends the Electron UA above.
// All three carry the same prefixed discovery ids back on the wire, so
// all three need the prefix stripped before Messages model resolution;
// other clients' opaque ids pass through untouched. The `claude-cli/`
// leading product token is part of the real-client detector documented at
// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/claude_code_validator.go
const CLAUDE_CODE_INFERENCE_USER_AGENT = /^(?:claude-cli\/|.*\bClaude\/\d)/;

export const decodeClaudeCodeModelId = (
  modelId: string,
  userAgent: string | undefined,
): string =>
  CLAUDE_CODE_INFERENCE_USER_AGENT.test(userAgent ?? '')
  && modelId.startsWith(CLAUDE_CODE_SYNTHETIC_PREFIX)
    ? modelId.slice(CLAUDE_CODE_SYNTHETIC_PREFIX.length)
    : modelId;
